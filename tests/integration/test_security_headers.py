"""En-têtes de sécurité HTTP (middleware global) — durcissement audit 2026-06.

Vérifie la politique sur une route API (JSON) et sur la SPA (HTML), l'exemption CSP des
docs interactives, et le HSTS conditionné à `session_https_only` (jamais sur le pilote HTTP).
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


def _settings(tmp_path, **kw) -> Settings:
    kw.setdefault("dev_open_admin", True)
    kw.setdefault("session_https_only", False)  # posture pilote HTTP (livrée par défaut)
    return Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=f"sqlite:///{tmp_path / 'hdr.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


def _fake_dist(tmp_path):
    """Mini build SPA déterministe (le vrai frontend/dist peut être absent en CI)."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><html><body>spa</body></html>", encoding="utf-8")
    return dist


@pytest.fixture
def client(tmp_path):
    settings = _settings(tmp_path, frontend_dist=str(_fake_dist(tmp_path)))
    with TestClient(create_app(settings)) as c:
        yield c


def test_api_route_has_baseline_headers_but_no_csp(client):
    r = client.get("/api/status")
    assert r.status_code == 200
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "same-origin"
    # CSP réservée au HTML : inutile (et bruyante) sur du JSON.
    assert "Content-Security-Policy" not in r.headers


def test_spa_html_gets_csp(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    csp = r.headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp
    assert "img-src 'self' data:" in csp
    assert "style-src 'self' 'unsafe-inline'" in csp
    assert "frame-ancestors 'none'" in csp
    # Les en-têtes de base sont aussi présents sur la SPA.
    assert r.headers["X-Frame-Options"] == "DENY"


def test_hsts_absent_on_http_pilot(client):
    # Pilote HTTP (session_https_only=false) : poser HSTS casserait l'accès du site.
    assert "Strict-Transport-Security" not in client.get("/api/status").headers
    assert "Strict-Transport-Security" not in client.get("/").headers


def test_hsts_present_behind_tls(tmp_path):
    settings = _settings(tmp_path, session_https_only=True)
    with TestClient(create_app(settings)) as c:
        hsts = c.get("/api/status").headers.get("Strict-Transport-Security", "")
        assert "max-age=" in hsts


def test_docs_html_exempt_from_csp(tmp_path):
    # /docs (Swagger, monté en dev via EXPOSE_API_DOCS) charge un CDN + script inline :
    # la CSP SPA le casserait — exempté, mais les autres en-têtes restent posés.
    settings = _settings(tmp_path, expose_api_docs=True)
    with TestClient(create_app(settings)) as c:
        r = c.get("/docs")
        assert r.status_code == 200
        assert "Content-Security-Policy" not in r.headers
        assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_metrics_endpoint_not_broken(tmp_path):
    settings = _settings(tmp_path, metrics_enabled=True)
    with TestClient(create_app(settings)) as c:
        r = c.get("/metrics")
        assert r.status_code == 200
        assert "Content-Security-Policy" not in r.headers  # text/plain
        assert r.headers["X-Content-Type-Options"] == "nosniff"
