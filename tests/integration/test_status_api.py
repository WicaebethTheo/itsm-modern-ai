"""`GET /api/status` à deux niveaux (durcissement audit 2026-06).

Public : strict état de marche (ok, version, polling) — l'installeur sonde cet endpoint
et attend un 200 SANS auth. Enrichi (compteurs LLM, coût 24 h, plafond, volumétrie des
référentiels) : uniquement avec une session admin valide. Les valeurs polling/plafond
sont les valeurs RUNTIME (surcharges UI), pas les seules valeurs d'environnement.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai import __version__
from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings

ENRICHED_FIELDS = {
    "polling_interval_seconds",
    "whitelist_loaded",
    "categories_count",
    "technicians_count",
    "llm_calls_total",
    "cost_eur_last_24h",
    "cost_cap_eur_per_day",
}


def _settings(tmp_path, **kw) -> Settings:
    kw.setdefault("session_https_only", False)  # TestClient = http → cookie non-Secure
    return Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=f"sqlite:///{tmp_path / 'st.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


@pytest.fixture
def secured_client(tmp_path):
    with TestClient(create_app(_settings(tmp_path, admin_password="s3cret"))) as c:
        yield c


def test_public_status_is_minimal_no_cost_nor_volumetry(secured_client):
    """Non authentifié : 200 (installeur) mais AUCUN compteur/coût/volumétrie divulgué."""
    r = secured_client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["version"] == __version__
    assert body["polling_enabled"] is False
    assert ENRICHED_FIELDS.isdisjoint(body.keys())


def test_authenticated_status_is_enriched(secured_client):
    secured_client.post("/api/auth/login", json={"password": "s3cret"})
    body = secured_client.get("/api/status").json()
    assert body["ok"] is True and body["version"] == __version__
    assert ENRICHED_FIELDS <= body.keys()
    assert body["whitelist_loaded"] is False
    assert body["llm_calls_total"] == 0
    assert body["cost_cap_eur_per_day"] == 5.0


def test_status_stays_200_when_fail_closed(tmp_path):
    """Fail-closed (pas de mot de passe, pas de dev_open) : l'installeur doit toujours
    obtenir un 200 public — seul l'enrichissement est refusé."""
    with TestClient(create_app(_settings(tmp_path, dev_open_admin=False))) as c:
        r = c.get("/api/status")
        assert r.status_code == 200
        assert ENRICHED_FIELDS.isdisjoint(r.json().keys())


def test_status_reflects_runtime_polling_overrides(secured_client):
    """Env dit polling OFF/60s ; l'UI (config runtime) dit ON/120s → status suit le runtime."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    app = secured_client.app
    with db.session_scope() as s:
        cfg = RuntimeConfigService(s, app.state.secrets_box, app.state.settings)
        cfg.set("polling_enabled", "true")
        cfg.set("polling_interval_seconds", "120")

    secured_client.post("/api/auth/login", json={"password": "s3cret"})
    body = secured_client.get("/api/status").json()
    assert body["polling_enabled"] is True
    assert body["polling_interval_seconds"] == 120


def test_status_and_metrics_reflect_runtime_cost_cap(tmp_path):
    """Le plafond affiché (status + /api/metrics) est la valeur RUNTIME lue par le moteur
    (api/runtime.py), pas la seule valeur d'environnement."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    with TestClient(create_app(_settings(tmp_path, dev_open_admin=True))) as c:
        with db.session_scope() as s:
            RuntimeConfigService(s, c.app.state.secrets_box, c.app.state.settings).set(
                "cost_cap_eur_per_day", "9.5"
            )
        assert c.get("/api/status").json()["cost_cap_eur_per_day"] == 9.5
        assert c.get("/api/metrics").json()["cost_cap_eur_per_day"] == 9.5
