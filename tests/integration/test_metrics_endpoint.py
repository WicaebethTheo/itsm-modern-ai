"""Endpoint Prometheus /metrics (observabilité infra — durcissement audit 2026-05).

Vérifie : exposition non authentifiée, format Prometheus, instrumentation des
requêtes (compteur), label `path` templaté (pas de PII/cardinalité explosive),
et désactivation via settings.metrics_enabled.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


def _settings(tmp_path, **over):
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'm.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,
        frontend_dist=str(tmp_path / "dist"),
        **over,
    )


@pytest.fixture
def client(tmp_path):
    (tmp_path / "dist").mkdir(parents=True, exist_ok=True)
    with TestClient(create_app(_settings(tmp_path))) as c:
        yield c


def test_metrics_exposed_unauthenticated(client):
    r = client.get("/metrics")
    assert r.status_code == 200
    assert "text/plain" in r.headers["content-type"]
    # Format Prometheus : présence des séries déclarées.
    assert "itsm_http_requests_total" in r.text
    assert "itsm_http_request_duration_seconds" in r.text


def test_requests_are_counted(client):
    client.get("/health")
    body = client.get("/metrics").text
    # Le label path doit être la ROUTE templatée, pas une URL avec valeurs.
    assert 'path="/health"' in body
    # /metrics ne s'auto-instrumente pas.
    assert 'path="/metrics"' not in body


def test_metrics_can_be_disabled(tmp_path):
    (tmp_path / "dist").mkdir(parents=True, exist_ok=True)
    with TestClient(create_app(_settings(tmp_path, metrics_enabled=False))) as c:
        assert c.get("/metrics").status_code == 404


def test_metrics_token_required_when_set(tmp_path):
    """Si `metrics_token` est défini, /metrics exige le jeton (401 sinon)."""
    (tmp_path / "dist").mkdir(parents=True, exist_ok=True)
    with TestClient(create_app(_settings(tmp_path, metrics_token="scrape-secret"))) as c:
        # Sans jeton → 401.
        assert c.get("/metrics").status_code == 401
        # Mauvais jeton → 401.
        assert c.get("/metrics", headers={"Authorization": "Bearer nope"}).status_code == 401
        # Bon jeton via Bearer → 200.
        r = c.get("/metrics", headers={"Authorization": "Bearer scrape-secret"})
        assert r.status_code == 200 and "itsm_http_requests_total" in r.text
        # Bon jeton via X-Metrics-Token → 200.
        r2 = c.get("/metrics", headers={"X-Metrics-Token": "scrape-secret"})
        assert r2.status_code == 200
