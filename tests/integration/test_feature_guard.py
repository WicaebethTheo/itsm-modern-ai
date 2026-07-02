"""Garde open-core `require_feature` (api/feature_guard.py) — design open-core du dépôt.

Le code Supporter est LIVRÉ (installed) mais verrouillé : une route gardée répond
403 `feature_locked` sans licence valide, 200 dès qu'une clé valide est collée
(déverrouillage en place), et re-403 quand la clé est retirée.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.api.feature_guard import require_feature
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain import licensing
from itsm_modern_ai.domain.licensing import FEATURE_SCHEDULED_EXPORTS

from ..unit.test_licensing import EXPIRED, TEST_PUBLIC_KEY_HEX, VALID


@pytest.fixture(autouse=True)
def _use_test_publisher_key(monkeypatch):
    # Jetons signés par la paire de TEST (la clé privée de prod ne vit jamais ici) :
    # on substitue la clé publique vérifiée, comme dans test_license_api.py.
    monkeypatch.setattr(licensing, "PUBLISHER_PUBLIC_KEY_HEX", TEST_PUBLIC_KEY_HEX)


def _settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'fg.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,  # /api/license accessible sans mot de passe (test)
        session_https_only=False,
        # Pas de dist → pas de catch-all SPA, sinon il masquerait la route de test
        # ajoutée APRÈS create_app (l'ordre d'enregistrement des routes prime).
        frontend_dist=str(tmp_path / "nodist"),
    )


@pytest.fixture
def client(tmp_path):
    app = create_app(_settings(tmp_path))

    # Mini-route de test gardée par la feature : le garde est générique, on le couvre
    # sans dépendre d'une route Supporter réelle.
    router = APIRouter(prefix="/api/_test")
    guarded = Depends(require_feature(FEATURE_SCHEDULED_EXPORTS))
    unknown = Depends(require_feature("feature_inconnue"))

    @router.get("/locked", dependencies=[guarded])
    def locked() -> dict:
        return {"ok": True}

    @router.get("/unknown", dependencies=[unknown])
    def unknown_feature() -> dict:  # jamais atteignable : feature hors catalogue
        return {"ok": True}

    app.include_router(router)
    with TestClient(app) as c:
        yield c


def test_locked_without_license_returns_403_feature_locked(client):
    r = client.get("/api/_test/locked")
    assert r.status_code == 403
    detail = r.json()["detail"]
    assert detail["code"] == "feature_locked"
    assert detail["feature"] == FEATURE_SCHEDULED_EXPORTS


def test_valid_license_unlocks_route_in_place(client):
    assert client.post("/api/license", json={"key": VALID}).json()["valid"] is True
    r = client.get("/api/_test/locked")
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_removing_license_relocks_route(client):
    client.post("/api/license", json={"key": VALID})
    assert client.get("/api/_test/locked").status_code == 200
    client.request("DELETE", "/api/license")
    assert client.get("/api/_test/locked").status_code == 403


def test_expired_license_keeps_route_locked(client):
    client.post("/api/license", json={"key": EXPIRED})
    assert client.get("/api/_test/locked").status_code == 403


def test_unknown_feature_is_locked_even_with_valid_license(client):
    """`installed` est exigé AVANT `entitled` : une feature hors registre reste 403."""
    client.post("/api/license", json={"key": VALID})
    assert client.get("/api/_test/unknown").status_code == 403
