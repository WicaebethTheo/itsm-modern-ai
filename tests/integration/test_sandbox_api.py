"""Endpoint sandbox (triage à blanc, sans écriture GLPI) — LLM mocké via respx."""

from __future__ import annotations

import httpx
import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings

LLM_BASE = "https://llm.test/v1"


@pytest.fixture
def client(db_url):
    settings = Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        llm_base_url=LLM_BASE,
        polling_enabled=False,
        dev_open_admin=True,  # admin sans mot de passe (test) — fail-closed désactivé
        ssrf_guard_enabled=False,  # respx mocke llm.test (pas de DNS réel) — garde off en test
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_sandbox_requires_llm_configured(client):
    r = client.post("/api/sandbox", json={"content": "pc lent"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "llm_not_configured"


@respx.mock
def test_sandbox_returns_decision_without_writing(client):
    # Pousser la clé LLM via l'API (comme le ferait l'UI).
    client.post("/api/config", json={"llm_api_key": "sk-test"})
    # Charger une whitelist en cache via le câblage interne, ET en base — pour que
    # les noms (catégorie / technicien) soient résolus comme dans le Journal.
    from itsm_modern_ai.domain.models import Referentials
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services import referentials

    refs = Referentials(categories={1: "Compte"}, technicians={11: "Syl"})
    client.app.state.whitelist_cache.refresh(refs)
    with db.session_scope() as s:
        referentials.sync(s, refs)
        # Le périmètre EFFECTIF (lu par la sandbox) ne retient que les éléments
        # sélectionnés/éligibles ; on les active explicitement en base.
        referentials.set_scope(s, category_ids=[1], entity_ids=[])
        referentials.set_eligibility(
            s, referentials.KIND_TECHNICIAN, [{"ext_id": 11, "eligible": True}]
        )
    decision_json = (
        '{"category":1,"priority":3,"technician_id":11,"draft":"Bonjour","confidence":0.88}'
    )
    respx.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": decision_json}}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 10},
            },
        )
    )
    r = client.post("/api/sandbox", json={"content": "je n'arrive plus à me connecter"})
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] is True
    assert body["technician_id"] == 11 and body["confidence"] == 0.88
    # Noms résolus depuis le ReferentialCache (utilisés par l'UI pour afficher « Syl » + #11).
    assert body["category_name"] == "Compte"
    assert body["technician_name"] == "Syl"


@respx.mock
def test_sandbox_uses_db_scope_even_without_cache(client):
    """La sandbox doit lire le périmètre EFFECTIF en base, PAS le cache mémoire.

    Le cache `whitelist_cache.referentials` n'est peuplé que par le poller ; ici le
    polling est désactivé, donc le cache reste VIDE. Sans le correctif, la sandbox
    verrait une whitelist vide et renverrait « à trier ». On prouve l'acceptation en
    n'alimentant QUE la base (périmètre effectif : catégorie sélectionnée + tech éligible).
    """
    client.post("/api/config", json={"llm_api_key": "sk-test"})
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import ReferentialCache
    from itsm_modern_ai.services import referentials

    # Cache mémoire volontairement VIDE (jamais peuplé par un poller).
    assert client.app.state.whitelist_cache.referentials.categories == {}

    # Périmètre en base : catégorie sélectionnée + technicien éligible.
    with db.session_scope() as s:
        s.add(ReferentialCache(kind=referentials.KIND_CATEGORY, ext_id=1, name="Compte", selected=True))
        s.add(ReferentialCache(kind=referentials.KIND_TECHNICIAN, ext_id=11, name="Syl", eligible=True))
        s.commit()

    decision_json = (
        '{"category":1,"priority":3,"technician_id":11,"draft":"Bonjour","confidence":0.88}'
    )
    respx.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": decision_json}}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 10},
            },
        )
    )
    r = client.post("/api/sandbox", json={"content": "je n'arrive plus à me connecter"})
    assert r.status_code == 200
    body = r.json()
    # Accepté grâce au seul périmètre DB → preuve que la sandbox n'utilise plus le cache.
    assert body["accepted"] is True
    assert body["reason"] == "accepted"
    assert body["category"] == 1 and body["technician_id"] == 11


# ── M3 : la sandbox respecte le cost cap ET journalise l'appel LLM ────────────
@respx.mock
def test_sandbox_journals_llm_call_visible_in_cost(client):
    client.post(
        "/api/config",
        json={
            "llm_api_key": "sk-test",
            "llm_price_input_per_mtok": 2.0,
            "llm_price_output_per_mtok": 6.0,
        },
    )
    decision_json = (
        '{"category":1,"priority":3,"technician_id":11,"draft":"Bonjour","confidence":0.88}'
    )
    respx.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": decision_json}}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 500},
            },
        )
    )
    # Base vierge : aucun appel comptabilisé.
    assert client.get("/api/cost").json()["llm_calls_total"] == 0
    r = client.post("/api/sandbox", json={"content": "mon mail est alice@acme.com"})
    assert r.status_code == 200
    cost = client.get("/api/cost").json()
    # L'appel sandbox est désormais journalisé (ticket_id=0) et compté dans le cost cap.
    assert cost["llm_calls_total"] == 1
    # Coût = 1000/1e6*2 + 500/1e6*6 = 0.005 €.
    assert cost["spent_eur_last_24h"] > 0


# ── Intégrité de la preuve : le journal doit refléter CE QUI EST SORTI ────────
@respx.mock
def test_sandbox_journal_prompt_is_exactly_what_was_sent(client):
    """La trace d'audit ne doit jamais attester d'un masquage qui n'a pas eu lieu.

    La sandbox journalisait avec les flags PAR DÉFAUT de `masking.mask()` (tous actifs) et
    sans la passe avancée, alors que le prompt réellement envoyé utilise les flags du
    service — où `iban`/`secret`/`network` valent False en édition Community (gating
    Supporter). Résultat : la DPO relisait `[IBAN]`/`[SECRET]`/`[IP]` pour des données
    parties EN CLAIR chez le fournisseur, exactement à l'inverse de la réalité.

    On verrouille la propriété la plus forte possible : le prompt journalisé est un
    EXTRAIT EXACT du corps de la requête HTTP envoyée au LLM.
    """
    import json

    from sqlmodel import select

    from itsm_modern_ai.domain import masking
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import LlmCall

    client.post("/api/config", json={"llm_api_key": "sk-test"})
    route = respx.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"category":1,"priority":3,"technician_id":11,'
                                                    '"draft":"Bonjour","confidence":0.88}'}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2},
            },
        )
    )
    contenu = (
        "IBAN FR76 3000 4000 5000 6000 7000 189 — mot de passe : Azerty1234 "
        "— poste 10.0.1.42 — mail alice@acme.com"
    )
    assert client.post("/api/sandbox", json={"content": contenu}).status_code == 200

    envoye = json.loads(route.calls.last.request.content)["messages"][-1]["content"]
    with db.session_scope() as s:
        journalise = s.exec(select(LlmCall)).one().prompt_sent

    # La preuve est littéralement un morceau du prompt envoyé : aucun écart possible.
    assert journalise in envoye

    # Édition Community (pas de licence) : IBAN / secret / IP ne sont PAS masqués — le
    # journal doit le montrer tel quel, sans placeholder trompeur.
    for en_clair in ("FR76 3000 4000 5000 6000 7000 189", "Azerty1234", "10.0.1.42"):
        assert en_clair in journalise
    for mensonge in ("[IBAN]", "[SECRET]", "[IP]"):
        assert mensonge not in journalise

    # E-mail : masqué en Community → masqué des DEUX côtés (envoi et journal).
    assert "alice@acme.com" not in journalise and "alice@acme.com" not in envoye
    assert masking.EMAIL_PLACEHOLDER in journalise


def test_sandbox_refused_over_cost_cap(client):
    # Plafond quasi nul + une dépense seedée → is_over_cap True AVANT tout appel LLM.
    client.post("/api/config", json={"llm_api_key": "sk-test", "cost_cap_eur_per_day": 0.001})
    from itsm_modern_ai.persistence import db, journal

    with db.session_scope() as s:
        journal.record_llm_call(
            s,
            ticket_id=0,
            model="m",
            prompt_sent="x",
            response_received="y",
            prompt_tokens=0,
            completion_tokens=0,
            cost_eur=1.0,
        )
    r = client.post("/api/sandbox", json={"content": "pc lent"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "cost_cap_reached"
