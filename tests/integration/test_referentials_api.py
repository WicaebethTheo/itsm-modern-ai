"""Référentiels : sélection du périmètre via l'UI (FR-3/7/15/16) + métriques + SPA."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain.models import Referentials


def _settings(tmp_path, **kw) -> Settings:
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 't.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,  # admin sans mot de passe (test) — fail-closed désactivé
        **kw,
    )


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(_settings(tmp_path))) as c:
        yield c


def _seed_cache():
    """Alimente le cache comme le ferait un scan GLPI."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services import referentials

    with db.session_scope() as s:
        referentials.sync(
            s,
            Referentials(
                categories={1: "Compte", 2: "RH"},
                technicians={11: "Sylvain", 12: "Nadia"},
                groups={5: "Support N2"},
                entities={0: "Racine"},
            ),
        )


def test_discovery_lists_cached(client):
    _seed_cache()
    techs = client.get("/api/discovery/technician").json()
    assert {t["ext_id"] for t in techs} == {11, 12}
    assert all(t["eligible"] is False for t in techs)
    assert client.get("/api/discovery/unknown").status_code == 404


def test_set_and_read_execution_mode_per_entity(client):
    _seed_cache()
    # Entité sans mode → null par défaut (= défaut global).
    entities = client.get("/api/discovery/entity").json()
    assert entities[0]["mode"] is None
    # Régler full_auto sur l'entité racine.
    resp = client.put("/api/modes", json=[{"ext_id": 0, "mode": "full_auto"}])
    assert resp.status_code == 200
    assert next(e for e in resp.json() if e["ext_id"] == 0)["mode"] == "full_auto"
    # Un mode invalide est rejeté (validation Pydantic).
    assert client.put("/api/modes", json=[{"ext_id": 0, "mode": "bogus"}]).status_code == 422


def test_select_eligibility_and_scope_drives_effective_whitelist(client):
    _seed_cache()
    client.put("/api/technicians", json=[{"ext_id": 11, "eligible": True, "skills": "AD, sécurité"}])
    client.put("/api/groups", json=[{"ext_id": 5, "eligible": True, "skills": "Niveau 2"}])
    assert client.put("/api/scope", json={"category_ids": [1], "entity_ids": [0]}).json()["category_ids"] == [1]

    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services import referentials

    with db.session_scope() as s:
        eff = referentials.effective_referentials(s)
        assert eff.categories == {1: "Compte"}  # 2 non sélectionnée
        assert eff.technicians == {11: "Sylvain"}  # 12 non éligible
        assert eff.groups == {5: "Support N2"}
        assert "AD, sécurité" in referentials.routing_prose(s)


def test_sync_requires_glpi_configured(client):
    assert client.post("/api/glpi/sync").status_code == 409


def test_metrics_endpoint(client):
    body = client.get("/api/metrics").json()
    assert body["total"] == 0 and body["cost_cap_eur_per_day"] == 5.0


def test_operational_metrics_unavailable_without_glpi(client):
    body = client.get("/api/operational-metrics").json()
    assert body["available"] is False and body["metrics"] is None


def test_root_reports_ui_not_built_when_no_dist(tmp_path):
    settings = _settings(tmp_path, frontend_dist=str(tmp_path / "nodist"))
    with TestClient(create_app(settings)) as c:
        r = c.get("/")
        assert r.status_code == 200 and r.json()["code"] == "ui_not_built"


def test_referentials_protected_when_auth_configured(tmp_path):
    settings = _settings(tmp_path, admin_password="pw")
    with TestClient(create_app(settings)) as c:
        assert c.get("/api/discovery/technician").status_code == 401
        assert c.get("/api/metrics").status_code == 401
