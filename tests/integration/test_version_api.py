"""Endpoint /api/version — version courante + vérif de MAJ opt-in (souverain)."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai import __version__
from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.api.routes.version import is_newer
from itsm_modern_ai.config.settings import Settings


def _settings(tmp_path, **kw) -> Settings:
    kw.setdefault("dev_open_admin", True)
    kw.setdefault("session_https_only", False)
    kw.setdefault("update_check_url", "")  # tests hors-ligne ; la prod active le check par défaut
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'v.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(_settings(tmp_path))) as c:
        yield c


def test_version_no_check_when_url_empty(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    body = r.json()
    assert body["current"] == __version__
    # URL vide (air-gap / opt-out) → aucun appel sortant, pas de MAJ signalée.
    assert body["check_enabled"] is False
    assert body["latest"] is None
    assert body["update_available"] is False


@pytest.mark.parametrize(
    ("latest", "current", "expected"),
    [
        ("0.8.0", "0.7.0", True),
        ("0.7.1", "0.7.0", True),
        ("0.7.0", "0.7.0", False),
        ("0.6.9", "0.7.0", False),
        ("v0.8.0", "0.7.0", True),  # tolère le préfixe v
        (None, "0.7.0", False),
    ],
)
def test_is_newer(latest, current, expected):
    assert is_newer(latest, current) is expected


def test_version_reports_runtime(client, monkeypatch):
    # Signal explicite ITSM_RUNTIME (posé dans l'image Docker) → reflété tel quel.
    monkeypatch.setenv("ITSM_RUNTIME", "docker")
    assert client.get("/api/version").json()["runtime"] == "docker"
    monkeypatch.setenv("ITSM_RUNTIME", "host")
    assert client.get("/api/version").json()["runtime"] == "host"
