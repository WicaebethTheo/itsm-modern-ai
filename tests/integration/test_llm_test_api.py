"""`POST /api/llm/test` — test de bout en bout du fournisseur IA (LLM mocké via respx).

Ce qui distingue cette route de la sonde `/health?probe=true` : elle fait un VRAI appel de
complétion et valide la Décision rendue. Elle voit donc les deux pannes que la sonde
`GET /models` ne pouvait pas voir — le modèle qui n'existe pas, et le modèle qui répond
autre chose qu'une Décision exploitable (le moteur enverrait alors tout « à trier » sans
qu'aucune panne ne soit visible).
"""

from __future__ import annotations

import httpx
import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.persistence import db, journal

LLM_BASE = "https://llm.test/v1"

DECISION_VALIDE = {
    "category": 1,
    "priority": 3,
    "technician_id": 11,
    "group_id": None,
    "draft": "Bonjour, nous prenons en charge votre demande.",
    "confidence": 0.83,
}


def _settings(db_url, **kw) -> Settings:
    kw.setdefault("dev_open_admin", True)  # admin sans mot de passe (test)
    return Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        llm_base_url=LLM_BASE,
        polling_enabled=False,
        session_https_only=False,
        ssrf_guard_enabled=False,  # respx mocke llm.test (pas de DNS réel) — garde off en test
        **kw,
    )


@pytest.fixture
def client(db_url):
    with TestClient(create_app(_settings(db_url))) as c:
        yield c


def _reponse_llm(contenu: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": contenu}}],
            "usage": {"prompt_tokens": 260, "completion_tokens": 90},
        },
    )


def test_le_test_exige_une_session(db_url, creer_compte_admin):
    with TestClient(create_app(_settings(db_url, dev_open_admin=False))) as c:
        creer_compte_admin(c)
        assert c.post("/api/llm/test").status_code == 401


def test_sans_cle_le_verdict_le_dit_au_lieu_d_echouer(client):
    """Aucun appel possible : c'est un état de configuration, pas une erreur d'API."""
    r = client.post("/api/llm/test")
    assert r.status_code == 200
    body = r.json()
    assert body["stage"] == "not_configured"
    assert body["ok"] is False


@respx.mock
def test_un_modele_qui_rend_une_decision_valide_est_declare_operationnel(client):
    import json as _json

    respx.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=_reponse_llm(_json.dumps(DECISION_VALIDE))
    )
    client.post("/api/config", json={"llm_api_key": "sk-test"})

    body = client.post("/api/llm/test").json()
    assert body["ok"] is True
    assert body["stage"] == "ok"
    # Ce que le modèle a PROPOSÉ : un « vert » muet ne prouverait pas qu'il a compris.
    assert body["priority"] == 3
    assert body["confidence"] == 0.83
    assert body["latency_ms"] is not None
    assert body["prompt_tokens"] == 260 and body["completion_tokens"] == 90

    # Un appel sortant facturé DOIT laisser une trace : sinon le test creuse une dépense
    # que ni le Journal ni le plafond de coût ne voient (défaut déjà corrigé sur la Sandbox).
    with db.session_scope() as s:
        assert journal.count_llm_calls(s) == 1


@respx.mock
def test_un_fournisseur_injoignable_est_qualifie_comme_tel(client):
    respx.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=httpx.Response(401, json={"error": {"message": "invalid api key"}})
    )
    client.post("/api/config", json={"llm_api_key": "sk-faux"})

    body = client.post("/api/llm/test").json()
    assert body["stage"] == "unreachable"
    assert body["ok"] is False
    assert body["error"]


@respx.mock
def test_un_modele_bavard_mais_inexploitable_n_est_PAS_confondu_avec_un_injoignable(client):
    """La panne que `GET /models` ne pouvait pas voir — et dont le remède est différent.

    Le fournisseur répond, la clé est bonne, le réseau passe : envoyer l'exploitant
    vérifier son URL et sa clé le ferait chercher là où il n'y a rien. Ce qu'il faut
    changer, c'est le MODÈLE.
    """
    respx.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=_reponse_llm("Bien sûr ! Voici ma réponse : je classe ce ticket en...")
    )
    client.post("/api/config", json={"llm_api_key": "sk-test"})

    body = client.post("/api/llm/test").json()
    assert body["stage"] == "invalid_output"
    assert body["ok"] is False


@respx.mock
def test_le_plafond_atteint_coupe_le_test_comme_il_coupe_le_moteur(client):
    """Tester au-delà du plafond dépenserait sur un budget déjà clos.

    Et rendrait un verdict que l'instance ne pourra pas honorer sur ses vrais tickets :
    le moteur, lui, ne passe plus aucun appel facturable.
    """
    route = respx.post(f"{LLM_BASE}/chat/completions").mock(return_value=httpx.Response(200))
    client.post("/api/config", json={"llm_api_key": "sk-test", "cost_cap_eur_per_day": 0.01})
    with db.session_scope() as s:
        journal.record_llm_call(
            s,
            ticket_id=0,
            model="m",
            prompt_sent="x",
            response_received="y",
            prompt_tokens=1,
            completion_tokens=1,
            cost_eur=5.0,
        )

    body = client.post("/api/llm/test").json()
    assert body["stage"] == "cost_cap_reached"
    assert body["ok"] is False
    assert route.call_count == 0  # rien n'est parti chez le fournisseur


@respx.mock
def test_un_modele_local_ne_facture_rien(client):
    """Ollama tourne sur l'infrastructure de l'exploitant : lui prêter un coût l'inventerait.

    Même arbitrage que le moteur (`api/runtime.FOURNISSEURS_SANS_FACTURATION`) : le coût
    du test doit valoir 0, pas le tarif par défaut de 2 €/Mtok.
    """
    import json as _json

    ollama = "http://localhost:11434/v1"
    respx.post(f"{ollama}/chat/completions").mock(
        return_value=_reponse_llm(_json.dumps(DECISION_VALIDE))
    )
    client.post(
        "/api/config",
        json={"llm_provider": "ollama", "ollama_base_url": ollama, "ollama_model": "llama3.1"},
    )

    body = client.post("/api/llm/test").json()
    assert body["ok"] is True
    assert body["cost_eur"] == 0.0
