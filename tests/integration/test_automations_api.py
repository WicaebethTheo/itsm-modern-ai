"""Automations API : rétention RGPD (vue, mise à jour, exécution manuelle)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'auto.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,  # admin sans mot de passe (test) — fail-closed désactivé
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_get_retention_returns_defaults(client):
    body = client.get("/api/automations/retention").json()
    assert body == {
        "enabled": True,
        "decisions_days": 365,
        "llm_calls_days": 90,
        "hour_utc": 3,
        "last_run_at": None,
        "last_decisions_deleted": None,
        "last_llm_calls_deleted": None,
        "last_run_by": None,
    }


def test_patch_retention_persists_and_validates(client):
    r = client.patch(
        "/api/automations/retention",
        json={"enabled": False, "decisions_days": 30, "llm_calls_days": 14, "hour_utc": 5},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is False
    assert body["decisions_days"] == 30 and body["llm_calls_days"] == 14
    assert body["hour_utc"] == 5

    # Validation Pydantic — hour_utc hors plage doit être rejeté.
    bad = client.patch("/api/automations/retention", json={"hour_utc": 99})
    assert bad.status_code == 422


def test_run_retention_requires_confirm(client):
    """Garde-fou anti-clic-malheureux/CSRF : aligné sur /api/debug/purge-users."""
    # Sans body → 422 (champ confirm requis).
    assert client.post("/api/automations/retention/run").status_code == 422
    # confirm avec une autre valeur → 422 (Literal["PURGER"]).
    bad = client.post("/api/automations/retention/run", json={"confirm": "ok"})
    assert bad.status_code == 422


def test_run_retention_purges_old_rows_and_audits(client):
    """POST /run supprime hors fenêtre, met à jour le dernier run + audit trail (qui)."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import DecisionLog, LlmCall

    now = datetime.now(UTC)
    with db.session_scope() as s:
        s.add(DecisionLog(ticket_id=1, ts=now - timedelta(days=400), accepted=True, reason="accepted"))
        s.add(DecisionLog(ticket_id=2, ts=now - timedelta(days=10), accepted=True, reason="accepted"))
        s.add(LlmCall(ticket_id=1, ts=now - timedelta(days=200)))
        s.add(LlmCall(ticket_id=2, ts=now - timedelta(days=30)))
        s.commit()

    r = client.post("/api/automations/retention/run", json={"confirm": "PURGER"})
    assert r.status_code == 200
    body = r.json()
    assert body["decisions_deleted"] == 1
    assert body["llm_calls_deleted"] == 1
    # La vue inclut le timestamp, les compteurs et l'identifiant de l'initiateur (audit RGPD).
    assert body["view"]["last_decisions_deleted"] == 1
    assert body["view"]["last_llm_calls_deleted"] == 1
    assert body["view"]["last_run_at"] is not None
    assert body["view"]["last_run_by"]  # IP du TestClient (testclient) ou similaire — non-vide
