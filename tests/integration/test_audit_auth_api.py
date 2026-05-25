"""Epic 4 : journal (FR-20), export CSV (FR-21), auth locale (FR-24)."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain.models import Decision, TriageOutcome, TriageReason


def _seed_decision():
    from itsm_modern_ai.persistence import db, journal

    outcome = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        return journal.record_decision(s, 100, outcome, glpi_link="http://glpi/100")


def _settings(tmp_path, **kw) -> Settings:
    return Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=f"sqlite:///{tmp_path / 'a.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


# ── Auth NON configurée (pilote ouvert) ──────────────────────────────────────
@pytest.fixture
def open_client(tmp_path):
    with TestClient(create_app(_settings(tmp_path))) as c:
        yield c


def test_journal_open_when_no_admin_password(open_client):
    did = _seed_decision()
    r = open_client.get("/api/decisions")
    assert r.status_code == 200 and r.json()[0]["ticket_id"] == 100
    # annotation
    r2 = open_client.patch(f"/api/decisions/{did}/annotation", json={"annotation": "juste"})
    assert r2.json()["annotation"] == "juste"


def test_export_csv_open(open_client):
    _seed_decision()
    r = open_client.get("/api/export/decisions.csv")
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    assert "ticket_id" in r.text


# ── Auth configurée ───────────────────────────────────────────────────────────
@pytest.fixture
def secured_client(tmp_path):
    with TestClient(create_app(_settings(tmp_path, admin_password="s3cret"))) as c:
        yield c


def test_protected_without_login_is_401(secured_client):
    assert secured_client.get("/api/decisions").status_code == 401
    assert secured_client.post("/api/config", json={"llm_model": "x"}).status_code == 401
    assert secured_client.get("/api/export/decisions.csv").status_code == 401


def test_login_then_access(secured_client):
    assert secured_client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    ok = secured_client.post("/api/auth/login", json={"password": "s3cret"})
    assert ok.status_code == 200 and ok.json()["authenticated"] is True
    # session active → accès autorisé
    _seed_decision()
    assert secured_client.get("/api/decisions").status_code == 200
    assert secured_client.post("/api/config", json={"llm_model": "mistral-small-latest"}).status_code == 200
    # logout → de nouveau refusé
    secured_client.post("/api/auth/logout")
    assert secured_client.get("/api/decisions").status_code == 401


def test_auth_status_reports_configured(secured_client):
    body = secured_client.get("/api/auth/status").json()
    assert body["auth_configured"] is True and body["authenticated"] is False


def test_status_counters_present(open_client):
    body = open_client.get("/api/status").json()
    assert "llm_calls_total" in body and "cost_eur_last_24h" in body
    assert body["cost_cap_eur_per_day"] == 5.0
