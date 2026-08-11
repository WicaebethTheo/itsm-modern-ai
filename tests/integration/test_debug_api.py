"""Outils de debug (/api/debug) — gating par flag + auth + confirmation purge."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


def _client(db_url, **kw):
    settings = Settings(
        _env_file=None,
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,  # admin sans mot de passe (test) — fail-closed désactivé
        **kw,
    )
    return TestClient(create_app(settings))


def test_disabled_by_default(db_url):
    with _client(db_url) as c:
        assert c.get("/api/debug/status").json() == {"enabled": False}
        # Endpoints d'action inertes quand le flag est off.
        assert c.get("/api/debug/diagnostics").status_code == 403
        assert c.post("/api/debug/seed", json={"technicians": 1, "groups": 1}).status_code == 403
        assert c.post("/api/debug/purge-users", json={"confirm": "SUPPRIMER"}).status_code == 403


@pytest.fixture
def enabled(db_url):
    with _client(db_url, debug_tools_enabled=True) as c:
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


# ── Fuite de détail d'exception (durcissement audit 2026-08) ──────────────────
# `/api/debug/seed` et `/api/debug/purge-users` renvoyaient `str(exc)` BRUT, qui embarque
# `resp.text[:200]` du GLPI — alors que `detail_sur` avait précisément été créé pour ça
# quelques lignes plus haut dans le même fichier (incohérence de durcissement).
def _configure_glpi(client) -> None:
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    with db.session_scope() as s:
        cfg = RuntimeConfigService(s, client.app.state.secrets_box, client.app.state.settings)
        cfg.set("glpi_base_url", "https://glpi.local/apirest.php")
        cfg.set_secret("glpi_user_token", "user-token")
        cfg.set_secret("glpi_app_token", "app-token")


@pytest.mark.parametrize(
    ("path", "body"),
    [("/api/debug/seed", {"technicians": 1, "groups": 1}),
     ("/api/debug/purge-users", {"confirm": "SUPPRIMER"})],
)
def test_glpi_error_detail_is_masked_and_bounded(enabled, monkeypatch, path, body):
    from itsm_modern_ai.adapters.itsm.glpi.debug import GlpiDebugOps
    from itsm_modern_ai.domain.errors import ItsmError

    _configure_glpi(enabled)

    async def _boom(*_a, **_k):
        # Reproduit un corps d'erreur GLPI recraché tel quel dans l'exception.
        raise ItsmError("GLPI 500: contact admin@exemple.fr — " + "x" * 600)

    monkeypatch.setattr(GlpiDebugOps, "seed", _boom)
    monkeypatch.setattr(GlpiDebugOps, "purge_users", _boom)

    r = enabled.post(path, json=body)
    assert r.status_code == 502
    message = r.json()["detail"]["message"]
    assert "admin@exemple.fr" not in message and "[EMAIL]" in message  # masquage PII
    assert len(message) <= 301  # borné (_DETAIL_MAX_CHARS + « … »)
