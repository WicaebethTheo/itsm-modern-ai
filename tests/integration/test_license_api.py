"""Endpoint /api/license (page Supporter) — édition, saisie de clé, features.

Édition unique : les 3 features Supporter sont LIVRÉES dans l'image (`installed=True`)
mais restent verrouillées (`active=False`) tant qu'aucune licence valide ne les autorise.
Une clé valide les rend ACTIVES (installed ∧ entitled).
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain import licensing

from ..unit.test_licensing import EXPIRED, TEST_PUBLIC_KEY_HEX, VALID


@pytest.fixture(autouse=True)
def _use_test_publisher_key(monkeypatch):
    # Les jetons de test sont signés par la paire de TEST (jamais la clé de prod —
    # ce dépôt est mirroré public). On substitue donc la clé publique vérifiée.
    monkeypatch.setattr(licensing, "PUBLISHER_PUBLIC_KEY_HEX", TEST_PUBLIC_KEY_HEX)


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
    # Le catalogue des 3 features est exposé : code LIVRÉ (installed) mais verrouillé (inactif).
    keys = {f["key"] for f in body["features"]}
    assert keys == {"pii_advanced", "multi_entity", "scheduled_exports"}
    assert all(f["installed"] is True for f in body["features"])
    assert all(f["active"] is False and f["entitled"] is False for f in body["features"])


def test_paste_valid_key_activates_features(client):
    r = client.post("/api/license", json={"key": VALID})
    assert r.status_code == 200
    body = r.json()
    # La licence est valide (édition supporter, entitled=True)…
    assert body["edition"] == "supporter" and body["valid"] is True
    assert body["customer"] == "ACME DSI"
    assert all(f["entitled"] for f in body["features"])
    # …et le code est livré dans l'image unique → features ACTIVES.
    assert all(f["installed"] is True and f["active"] is True for f in body["features"])
    # Persistance : un GET ultérieur reflète l'édition supporter.
    assert client.get("/api/license").json()["edition"] == "supporter"


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
    assert client.get("/api/license").json()["edition"] == "supporter"
    r = client.request("DELETE", "/api/license")
    assert r.status_code == 200 and r.json()["edition"] == "community"
    assert client.get("/api/license").json()["edition"] == "community"


# ── M10 : DELETE doit re-verrouiller MÊME quand LICENSE_KEY est en env ────────
@pytest.fixture
def client_env_licensed(tmp_path):
    # Instance pré-licenciée via l'env LICENSE_KEY (image pré-licenciée).
    with TestClient(create_app(_settings(tmp_path, license_key=VALID))) as c:
        yield c


def test_delete_relocks_even_with_env_license_key(client_env_licensed):
    c = client_env_licensed
    # Pré-licenciée via env → supporter au démarrage.
    assert c.get("/api/license").json()["edition"] == "supporter"
    # DELETE : la sentinelle empêche le repli sur l'env → retour en community.
    r = c.request("DELETE", "/api/license")
    assert r.status_code == 200 and r.json()["edition"] == "community"
    assert c.get("/api/license").json()["edition"] == "community"
    # Re-POST d'une clé valide → de nouveau supporter (la sentinelle est écrasée).
    c.post("/api/license", json={"key": VALID})
    assert c.get("/api/license").json()["edition"] == "supporter"
