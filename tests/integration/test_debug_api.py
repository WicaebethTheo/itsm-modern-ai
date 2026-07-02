"""Outils de debug (/api/debug) — gating par flag + auth + confirmation purge."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


def _client(tmp_path, **kw):
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'd.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,  # admin sans mot de passe (test) — fail-closed désactivé
        **kw,
    )
    return TestClient(create_app(settings))


def test_disabled_by_default(tmp_path):
    with _client(tmp_path) as c:
        assert c.get("/api/debug/status").json() == {"enabled": False}
        # Endpoints d'action inertes quand le flag est off.
        assert c.get("/api/debug/diagnostics").status_code == 403
        assert c.post("/api/debug/seed", json={"technicians": 1, "groups": 1}).status_code == 403
        assert c.post("/api/debug/purge-users", json={"confirm": "SUPPRIMER"}).status_code == 403


@pytest.fixture
def enabled(tmp_path):
    with _client(tmp_path, debug_tools_enabled=True) as c:
        yield c


def test_status_enabled(enabled):
    assert enabled.get("/api/debug/status").json() == {"enabled": True}


def test_info_exposes_version_and_endpoints(enabled):
    from itsm_modern_ai import __version__

    body = enabled.get("/api/debug/info").json()
    assert body["version"] == __version__
    paths = {e["path"] for e in body["endpoints"]}
    assert "/health" in paths and "/api/config" in paths


def test_diagnostics_without_glpi(enabled):
    body = enabled.get("/api/debug/diagnostics").json()
    assert body["glpi"]["configured"] is False and body["llm"]["configured"] is False


def test_seed_requires_glpi(enabled):
    assert enabled.post("/api/debug/seed", json={"technicians": 1, "groups": 1}).status_code == 409


def test_purge_requires_confirmation(enabled):
    # Mauvaise confirmation → 400 (avant toute action).
    assert enabled.post("/api/debug/purge-users", json={"confirm": "oui"}).status_code == 400
    # Bonne confirmation mais pas de GLPI → 409 (toujours pas de purge réelle).
    assert enabled.post("/api/debug/purge-users", json={"confirm": "SUPPRIMER"}).status_code == 409
