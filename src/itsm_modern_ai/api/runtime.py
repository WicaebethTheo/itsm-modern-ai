"""Câblage runtime partagé : connecteur GLPI, LLM et service de triage.

Tout est (re)construit à partir de la config runtime (poussée via l'API/UI), donc un
changement de tokens GLPI / clé LLM est pris en compte au cycle suivant sans redémarrage.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..adapters.itsm.glpi.connector import GlpiConnector
from ..adapters.llm.registry import build_llm as _build_llm_adapter
from ..adapters.secrets.encrypted import FernetSecretsBox
from ..config.settings import Settings
from ..persistence import db
from ..ports.itsm import ItsmPort
from ..ports.llm import LlmPort
from ..ports.secrets import SecretsPort
from ..services.runtime_config import RuntimeConfigService
from ..services.tech_profiles import load_tech_profiles
from ..services.triage import TriageService

logger = logging.getLogger("itsm.runtime")


def make_secrets_box(settings: Settings) -> FernetSecretsBox:
    return FernetSecretsBox(master_key=settings.master_key)


def build_connector(settings: Settings, secrets: SecretsPort) -> GlpiConnector | None:
    """Construit un GlpiConnector si GLPI est configuré, sinon None."""
    with db.session_scope() as session:
        creds = RuntimeConfigService(session, secrets, settings).glpi_credentials()
    if not creds.is_configured:
        return None
    return GlpiConnector(creds, max_tickets=settings.polling_max_tickets)


def build_llm(settings: Settings, secrets: SecretsPort) -> LlmPort | None:
    """Construit le connecteur LLM selon le fournisseur configuré (clé poussée via l'UI)."""
    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, secrets, settings)
        provider = cfg.get("llm_provider") or settings.llm_provider
        if provider == "anthropic":
            api_key = cfg.get_secret("anthropic_api_key")
            base_url = cfg.get("anthropic_base_url") or settings.anthropic_base_url
            model = cfg.get("anthropic_model") or settings.anthropic_model
        else:
            api_key = cfg.get_secret("llm_api_key")
            base_url = cfg.get("llm_base_url") or settings.llm_base_url
            model = cfg.get("llm_model") or settings.llm_model
    if not api_key:
        return None
    return _build_llm_adapter(
        provider=provider,
        base_url=base_url,
        api_key=api_key,
        model=model,
        anthropic_version=settings.anthropic_version,
    )


def _load_profiles_prose(settings: Settings) -> str:
    path = Path(settings.tech_profiles_path)
    if not path.exists():
        logger.info("fiches techniciens absentes (%s) — routage sans prose", path)
        return ""
    try:
        return load_tech_profiles(path).as_prose()
    except Exception as exc:  # fichier mal formé → ne pas bloquer le moteur
        logger.warning("fiches techniciens illisibles (%s): %s", path, exc)
        return ""


def build_triage_service(
    settings: Settings, secrets: SecretsPort, itsm: ItsmPort | None = None
) -> TriageService | None:
    """Service de triage complet, ou None si le LLM n'est pas configuré."""
    llm = build_llm(settings, secrets)
    if llm is None:
        return None
    return TriageService(
        itsm=itsm,
        llm=llm,
        settings=settings,
        tech_profiles_prose=_load_profiles_prose(settings),
        session_factory=db.session_scope,
    )
