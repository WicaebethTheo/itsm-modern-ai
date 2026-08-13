"""/health — amplification de requêtes sortantes (durcissement audit 2026-08).

Défaut prouvé : un `GET /health` ANONYME déclenchait 5 requêtes vers le GLPI du client
(initSession/killSession ×2 + getGlpiConfig), et `?probe=true` y ajoutait un appel facturé
au fournisseur LLM — sans cache, sans authentification, sans limite, sur un port publié en
`0.0.0.0`. Ce module vérifie les quatre garde-fous : cache TTL, sonde réservée à l'admin,
`/health/live` sans appel sortant, et 503 explicite sur secrets illisibles.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.api.routes import health as health_routes
from itsm_modern_ai.config.settings import Settings

PASSWORD = "s3cret-pilote"


def _settings(db_url, tmp_path, **kw) -> Settings:
    kw.setdefault("session_https_only", False)
    kw.setdefault("dev_open_admin", False)
    return Settings(
        _env_file=None,
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        frontend_dist=str(tmp_path / "dist"),
        **kw,
    )


class _SpyConnector:
    """Connecteur GLPI factice qui COMPTE ses appels sortants."""

    base_url = "https://glpi.local/apirest.php"

    def __init__(self) -> None:
        self.healthchecks = 0
        self.versions = 0

    async def healthcheck(self) -> bool:
        self.healthchecks += 1
        return True

    async def server_version(self) -> str:
        self.versions += 1
        return "10.0.18"


@pytest.fixture
def spy(monkeypatch) -> _SpyConnector:
    connector = _SpyConnector()
    monkeypatch.setattr(health_routes, "build_connector", lambda *a, **k: connector)
    monkeypatch.setattr(health_routes, "build_llm", lambda *a, **k: None)
    return connector


# ── (a) cache TTL sur le résultat COMPLET ─────────────────────────────────────
def test_health_result_is_cached(db_url, tmp_path, spy):
    """Marteler /health ne doit PAS marteler le GLPI du client."""
    with TestClient(create_app(_settings(db_url, tmp_path, dev_open_admin=True))) as c:
        for _ in range(10):
            assert c.get("/health").status_code == 200
    # 10 requêtes entrantes → 1 seul aller-retour sortant (TTL non expiré).
    assert spy.healthchecks == 1


def test_health_cache_expires(db_url, tmp_path, spy, monkeypatch):
    """Le cache reste une SONDE : passé le TTL, l'état est réinterrogé."""
    monkeypatch.setattr(health_routes, "HEALTH_CACHE_TTL_SECONDS", 0.0)
    with TestClient(create_app(_settings(db_url, tmp_path, dev_open_admin=True))) as c:
        c.get("/health")
        c.get("/health")
    assert spy.healthchecks == 2


# ── (b) ?probe=true réservé aux sessions authentifiées ────────────────────────
def test_probe_requires_authentication(db_url, tmp_path, spy, creer_compte_admin):
    """La sonde LLM coûte de l'argent : un anonyme ne doit pas pouvoir la déclencher."""
    with TestClient(create_app(_settings(db_url, tmp_path, dev_open_admin=False))) as c:
        creer_compte_admin(c, password=PASSWORD)
        r = c.get("/health?probe=true")
        assert r.status_code == 401
        assert r.json()["detail"]["code"] == "unauthorized"
        # Aucun appel sortant n'a été émis pour cette requête refusée.
        assert spy.healthchecks == 0
        # /health nu reste public (installeur, sonde réseau) — non-régression.
        assert c.get("/health").status_code == 200

        assert c.post(
            "/api/auth/login", json={"email": "admin@exemple.fr", "password": PASSWORD}
        ).status_code == 200
        assert c.get("/health?probe=true").status_code == 200


# ── (c) /health/live : aucun appel sortant ────────────────────────────────────
def test_health_live_makes_no_outbound_call(db_url, tmp_path, monkeypatch):
    """Sonde de vivacité destinée au healthcheck Docker : process + base, rien d'autre."""

    def _boom(*_a, **_k):  # pragma: no cover - ne doit jamais être appelé
        raise AssertionError("/health/live ne doit émettre AUCUN appel sortant")

    monkeypatch.setattr(health_routes, "build_connector", _boom)
    monkeypatch.setattr(health_routes, "build_llm", _boom)
    with TestClient(create_app(_settings(db_url, tmp_path))) as c:
        r = c.get("/health/live")  # public, sans session
        assert r.status_code == 200
        assert r.json() == {"status": "ok", "database": True}


def test_health_live_degrades_when_database_is_down(db_url, tmp_path, monkeypatch):
    with TestClient(create_app(_settings(db_url, tmp_path))) as c:
        from itsm_modern_ai.persistence import db

        monkeypatch.setattr(db, "session_scope", _raising_scope)
        r = c.get("/health/live")
        assert r.status_code == 503 and r.json()["database"] is False


def _raising_scope():
    raise RuntimeError("base injoignable")


# ── (d) secrets illisibles → 503 explicite (et non 500 opaque) ────────────────
def test_unreadable_secrets_return_503(db_url, tmp_path):
    """`master.key` incohérente : /health doit NOMMER la panne, pas rendre un 500 muet."""
    from itsm_modern_ai.adapters.secrets.encrypted import FernetSecretsBox
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    settings = _settings(db_url, tmp_path, dev_open_admin=True)
    with TestClient(create_app(settings)) as c:
        # Secrets GLPI chiffrés avec une AUTRE clé que celle de l'application.
        foreign = FernetSecretsBox(
            master_key=Fernet.generate_key().decode(), key_file=tmp_path / "foreign.key"
        )
        with db.session_scope() as s:
            cfg = RuntimeConfigService(s, foreign, settings)
            cfg.set("glpi_base_url", "https://glpi.local/apirest.php")
            cfg.set_secret("glpi_user_token", "tok")
            cfg.set_secret("glpi_app_token", "app")

        r = c.get("/health")
        assert r.status_code == 503
        assert r.json()["detail"]["code"] == "secrets_unreadable"
