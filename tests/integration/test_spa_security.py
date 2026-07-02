"""Sécurité du catch-all SPA : confinement des chemins (anti path traversal)."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


@pytest.fixture
def spa_client(tmp_path):
    """App avec une SPA buildée minimale + un fichier secret HORS du dist."""
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>SPA</html>", encoding="utf-8")
    (dist / "favicon.ico").write_text("icon", encoding="utf-8")
    # Fichier sensible hors du dist (simule master.key / .env / itsm.db).
    secret = tmp_path / "master.key"
    secret.write_text("TOP-SECRET-KEY", encoding="utf-8")

    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'a.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,
        frontend_dist=str(dist),
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_legit_static_file_served(spa_client):
    r = spa_client.get("/favicon.ico")
    assert r.status_code == 200 and r.text == "icon"


def test_unknown_route_falls_back_to_index(spa_client):
    r = spa_client.get("/dashboard")
    assert r.status_code == 200 and "SPA" in r.text


def test_path_traversal_encoded_does_not_escape(spa_client):
    """`..%2f..%2fmaster.key` ne doit JAMAIS lire un fichier hors du dist."""
    r = spa_client.get("/..%2f..%2fmaster.key")
    assert r.status_code == 200
    assert "TOP-SECRET-KEY" not in r.text
    assert "SPA" in r.text  # fallback index.html


def test_path_traversal_dotdot_does_not_escape(spa_client):
    r = spa_client.get("/../master.key", follow_redirects=True)
    assert "TOP-SECRET-KEY" not in r.text


def test_path_traversal_etc_passwd(spa_client):
    r = spa_client.get("/..%2f..%2f..%2f..%2f..%2fetc/passwd")
    assert r.status_code == 200
    assert "root:" not in r.text
    assert "SPA" in r.text
