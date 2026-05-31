"""Endpoint /api/license (Store) — édition, saisie de clé, features verrouillées.

Sur l'image Community (aucun plugin Enterprise installé), toutes les features ont
`installed=False` → `active=False` même avec une licence valide collée.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings

from ..unit.test_licensing import EXPIRED, VALID


def _settings(tmp_path, **kw) -> Settings:
    kw.setdefault("dev_open_admin", True)
    kw.setdefault("session_https_only", False)
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'lic.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(_settings(tmp_path))) as c:
        yield c


def test_default_edition_is_community(client):
    r = client.get("/api/license")
    assert r.status_code == 200
    body = r.json()
    assert body["edition"] == "community" and body["valid"] is False
    # Le catalogue des 3 features est exposé, toutes verrouillées.
    keys = {f["key"] for f in body["features"]}
    assert keys == {"pii_advanced", "multi_entity", "scheduled_exports"}
    assert all(f["active"] is False and f["installed"] is False for f in body["features"])


def test_paste_valid_key_marks_enterprise_but_features_not_installed(client):
    r = client.post("/api/license", json={"key": VALID})
    assert r.status_code == 200
    body = r.json()
    # La licence est valide (édition enterprise, entitled=True)…
    assert body["edition"] == "enterprise" and body["valid"] is True
    assert body["customer"] == "ACME DSI"
    assert all(f["entitled"] for f in body["features"])
    # …mais sur l'image Community le code n'est pas installé → inactif.
    assert all(f["installed"] is False and f["active"] is False for f in body["features"])
    # Persistance : un GET ultérieur reflète l'édition enterprise.
    assert client.get("/api/license").json()["edition"] == "enterprise"


def test_paste_invalid_key_is_rejected_and_not_stored(client):
    r = client.post("/api/license", json={"key": "itsm-lic.v1.bidon.bidon"})
    assert r.status_code == 200
    assert r.json()["valid"] is False and r.json()["error"]
    # Non stockée : on reste en community.
    assert client.get("/api/license").json()["edition"] == "community"


def test_expired_key_reports_error(client):
    r = client.post("/api/license", json={"key": EXPIRED})
    assert r.json()["valid"] is False
    assert r.json()["error"] == "licence expirée"


def test_delete_license_returns_to_community(client):
    client.post("/api/license", json={"key": VALID})
    assert client.get("/api/license").json()["edition"] == "enterprise"
    r = client.request("DELETE", "/api/license")
    assert r.status_code == 200 and r.json()["edition"] == "community"
    assert client.get("/api/license").json()["edition"] == "community"
