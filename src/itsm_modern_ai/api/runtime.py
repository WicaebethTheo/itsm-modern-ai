"""Câblage runtime partagé : construction du connecteur GLPI depuis la config.

Le connecteur est (re)construit à partir de la config runtime (poussée via l'API/UI),
donc tout changement de tokens GLPI est pris en compte au cycle de polling suivant
sans redémarrage.
"""

from __future__ import annotations

from ..adapters.itsm.glpi.connector import GlpiConnector
from ..adapters.secrets.encrypted import FernetSecretsBox
from ..config.settings import Settings
from ..persistence import db
from ..ports.secrets import SecretsPort
from ..services.runtime_config import RuntimeConfigService


def build_connector(
    settings: Settings, secrets: SecretsPort
) -> GlpiConnector | None:
    """Construit un GlpiConnector si GLPI est configuré, sinon None."""
    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, secrets, settings)
        creds = cfg.glpi_credentials()
    if not creds.is_configured:
        return None
    return GlpiConnector(creds, max_tickets=settings.polling_max_tickets)


def make_secrets_box(settings: Settings) -> FernetSecretsBox:
    return FernetSecretsBox(master_key=settings.master_key)
