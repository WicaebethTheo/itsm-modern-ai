"""Endpoints /api/privacy (DPO) et /api/cost — état masquage par édition + coûts."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


def _settings(tmp_path, **kw) -> Settings:
    kw.setdefault("dev_open_admin", True)
    kw.setdefault("session_https_only", False)
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'pc.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(_settings(tmp_path))) as c:
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
