"""/api/operational-metrics — fuite de détail d'exception (durcissement audit 2026-08).

`insights.py` renvoyait `Lecture GLPI impossible : {exc}` avec l'exception BRUTE, qui
embarque `resp.text[:200]` du serveur GLPI. Le même dépôt disposait déjà de `detail_sur`
(routes/debug.py), créé exactement pour ce risque : deux régimes de durcissement
incohérents dans la même API. Ce test verrouille l'alignement.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.api.routes import insights as insights_routes
from itsm_modern_ai.config.settings import Settings


@pytest.fixture
def client(db_url, tmp_path):
    settings = Settings(
        _env_file=None,
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,
        frontend_dist=str(tmp_path / "dist"),
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_operational_metrics_masks_glpi_error_detail(client, monkeypatch):
    from itsm_modern_ai.domain.errors import ItsmError

    class _Failing:
        base_url = "https://glpi.local/apirest.php"

        async def get_recent_tickets(self, _since):
            raise ItsmError("GLPI 500: contact admin@exemple.fr — " + "y" * 600)

    monkeypatch.setattr(insights_routes, "build_connector", lambda *a, **k: _Failing())

    body = client.get("/api/operational-metrics").json()
    assert body["available"] is False
    detail = body["detail"]
    assert detail.startswith("Lecture GLPI impossible : ")
    assert "admin@exemple.fr" not in detail and "[EMAIL]" in detail  # masquage PII
    assert len(detail) <= len("Lecture GLPI impossible : ") + 301  # borné


def test_operational_metrics_unavailable_without_glpi(client):
    """Non-régression : sans GLPI configuré, la vue reste « indisponible » (pas d'erreur)."""
    body = client.get("/api/operational-metrics").json()
    assert body["available"] is False and body["detail"] == "GLPI non configuré."
