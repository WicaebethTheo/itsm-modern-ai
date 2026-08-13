"""Endpoints /api/privacy (DPO) et /api/cost — état masquage par édition + coûts."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain import licensing

from ..unit.test_licensing import TEST_PUBLIC_KEY_HEX, VALID


def _settings(db_url, **kw) -> Settings:
    kw.setdefault("dev_open_admin", True)
    kw.setdefault("session_https_only", False)
    return Settings(
        _env_file=None,
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


@pytest.fixture
def client(db_url):
    with TestClient(create_app(_settings(db_url))) as c:
        yield c


def test_privacy_community_split(client):
    body = client.get("/api/privacy").json()
    assert body["edition_advanced"] is False
    cats = {c["key"]: c for c in body["categories"]}
    # Sans licence : email + phone masqués ; le reste = supporter, inactif.
    assert cats["email"]["scope"] == "community" and cats["email"]["active"] is True
    assert cats["phone"]["active"] is True
    for k in ("iban", "secret", "network", "nir_siret"):
        assert cats[k]["scope"] == "supporter"
        assert cats[k]["active"] is False
    # Patterns regex custom = capacité pas encore livrée → annoncée « roadmap », jamais active
    # (honnêteté DPO : ne pas afficher « masqué » tant que from_rules n'est pas câblé).
    assert cats["custom"]["scope"] == "roadmap"
    assert cats["custom"]["active"] is False
    assert "retention_llm_calls_days" in body


def test_test_mask_community_masks_email_not_iban(client):
    r = client.post("/api/privacy/test-mask", json={"text": "Mail alice@acme.com IBAN FR7630004000031234567890143"})
    assert r.status_code == 200
    out = r.json()["masked"]
    assert "[EMAIL]" in out  # email masqué (Community)
    assert "FR7630004000031234567890143" in out  # IBAN NON masqué (Supporter, sans licence)
    assert "[IBAN]" not in out


@pytest.fixture
def supporter_client(db_url, monkeypatch):
    """Client avec une licence Supporter VALIDE collée (paire de test, pas celle de prod)."""
    monkeypatch.setattr(licensing, "PUBLISHER_PUBLIC_KEY_HEX", TEST_PUBLIC_KEY_HEX)
    with TestClient(create_app(_settings(db_url))) as c:
        assert c.post("/api/license", json={"key": VALID}).json()["valid"] is True
        yield c


# NIR de test : 13 chiffres + clé = 97 - (numéro mod 97) — le même que tests/unit/test_features.
_NIR_VALID = "1 85 12 75 116 001 74"


def test_test_mask_counts_supporter_pass(supporter_client):
    """Un texte masqué UNIQUEMENT par la passe Supporter doit renvoyer des compteurs.

    Sans ça, l'écran DPO affichait « Aucun remplacement — ce texte part tel quel au LLM »
    juste sous le bloc qui montre `[NIR]` : sur la page destinée à la DPO, l'outil se
    contredisait lui-même. Les compteurs du cœur ne couvrent pas NIR/SIRET.
    """
    r = supporter_client.post("/api/privacy/test-mask", json={"text": f"NIR {_NIR_VALID}"})
    assert r.status_code == 200
    body = r.json()
    assert "[NIR]" in body["masked"] and _NIR_VALID not in body["masked"]
    assert body["counts"].get("nir") == 1
    # Le contrat de l'écran : un remplacement visible ⇒ au moins un compteur non nul.
    assert any(n > 0 for n in body["counts"].values())


def test_test_mask_counts_core_and_supporter_together(supporter_client):
    """Les deux passes s'additionnent dans le même dictionnaire, sans s'écraser.

    NB : le SIREN est ici à 9 chiffres. Un SIRET à 14 chiffres valide Luhn, donc le
    masquage CARTE du cœur l'attrape AVANT la passe Supporter (comportement du produit,
    pas de l'endpoint) — il ressortirait en `card`, ce qui rendrait le test trompeur.
    """
    body = supporter_client.post(
        "/api/privacy/test-mask",
        json={"text": f"Mail alice@acme.com, NIR {_NIR_VALID}, SIREN 123456782"},
    ).json()
    counts = body["counts"]
    assert counts["email"] == 1
    assert counts.get("nir") == 1
    assert counts.get("siret") == 1


def test_test_mask_without_pii_reports_nothing(supporter_client):
    """Aucun marqueur ajouté ⇒ aucun compteur : le repère « part tel quel » reste vrai."""
    body = supporter_client.post(
        "/api/privacy/test-mask", json={"text": "Le poste ne demarre plus depuis ce matin."}
    ).json()
    assert body["masked"] == "Le poste ne demarre plus depuis ce matin."
    assert all(n == 0 for n in body["counts"].values())


def test_test_mask_placeholder_already_in_input_is_not_counted(supporter_client):
    """Un `[NIR]` déjà présent dans le texte d'entrée n'est pas un remplacement."""
    body = supporter_client.post("/api/privacy/test-mask", json={"text": "vu un [NIR] ici"}).json()
    assert body["counts"].get("nir", 0) == 0


def test_dpo_report_downloads(client):
    r = client.get("/api/privacy/report.md")
    assert r.status_code == 200
    assert "attachment" in r.headers.get("content-disposition", "")
    assert "Rapport DPO" in r.text and "Adresses e-mail" in r.text


def test_cost_view(client):
    body = client.get("/api/cost").json()
    assert "cost_cap_eur_per_day" in body
    assert body["spent_eur_last_24h"] == 0.0  # rien dépensé sur une base vierge
    assert body["llm_calls_total"] == 0
    assert body["currency"] == "EUR"
