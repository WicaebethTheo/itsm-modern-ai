"""Câblage runtime (api/runtime.py) : le connecteur GLPI reçoit les bornes configurées."""

from __future__ import annotations

from cryptography.fernet import Fernet

from itsm_modern_ai.adapters.itsm.glpi.connector import GlpiConnector
from itsm_modern_ai.api.runtime import build_connector, make_secrets_box
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.persistence import db
from itsm_modern_ai.services.runtime_config import RuntimeConfigService


def test_legacy_connector_receives_stats_max(temp_db):
    """Régression : DASHBOARD_MAX_TICKETS était ignoré en legacy (seul le V2 le passait)."""
    settings = Settings(
        _env_file=None,
        master_key=Fernet.generate_key().decode(),
        dashboard_max_tickets=123,
        polling_max_tickets=7,
    )
    box = make_secrets_box(settings)
    with db.session_scope() as s:
        cfg = RuntimeConfigService(s, box, settings)
        cfg.set("glpi_base_url", "https://glpi.example.com/apirest.php")
        cfg.set_secret("glpi_user_token", "tok")

    connector = build_connector(settings, box)
    assert isinstance(connector, GlpiConnector)
    assert connector._stats_max == 123  # borne du Dashboard inversé honorée
    assert connector._max_tickets == 7  # borne du polling inchangée
