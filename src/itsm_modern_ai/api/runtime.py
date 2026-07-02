"""Câblage runtime partagé : connecteur GLPI, LLM et service de triage.

Tout est (re)construit à partir de la config runtime (poussée via l'API/UI), donc un
changement de tokens GLPI / clé LLM est pris en compte au cycle suivant sans redémarrage.
"""

from __future__ import annotations

import logging

from ..adapters.itsm.glpi.connector import GlpiConnector
from ..adapters.itsm.glpi.v2.connector import GlpiV2Connector
from ..adapters.llm.registry import build_llm as _build_llm_adapter
from ..adapters.secrets.encrypted import FernetSecretsBox
from ..config.settings import Settings
from ..domain.modes import ExecutionMode
from ..persistence import db
from ..ports.itsm import ItsmPort
from ..ports.llm import LlmPort
from ..ports.secrets import SecretsPort
from ..services import referentials
from ..services.runtime_config import RuntimeConfigService
from ..services.triage import TriageService

logger = logging.getLogger("itsm.runtime")


def make_secrets_box(settings: Settings) -> FernetSecretsBox:
    return FernetSecretsBox(master_key=settings.master_key)


def build_connector(
    settings: Settings, secrets: SecretsPort
) -> GlpiConnector | GlpiV2Connector | None:
    """Construit le connecteur GLPI selon `glpi_api_version` (legacy | v2), sinon None.

    - `legacy` (défaut, éprouvé) → `GlpiConnector` (apirest.php).
    - `v2` (Beta) → `GlpiV2Connector` (API haut-niveau OAuth2).
    Les deux implémentent `ItsmPort` : le reste du moteur est agnostique.
    """
    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, secrets, settings)
        api_version = (cfg.get("glpi_api_version") or "legacy").strip().lower()
        if api_version == "v2":
            v2_creds = cfg.glpi_v2_credentials()
            if not v2_creds.is_configured:
                return None
            return GlpiV2Connector(
                v2_creds,
                max_tickets=settings.polling_max_tickets,
                stats_max=settings.dashboard_max_tickets,
                ssrf_guard=settings.ssrf_guard_enabled,
            )
        creds = cfg.glpi_credentials()
    if not creds.is_configured:
        return None
    return GlpiConnector(
        creds,
        max_tickets=settings.polling_max_tickets,
        # Borne du Dashboard inversé (DASHBOARD_MAX_TICKETS) : sans elle, le legacy
        # restait figé au défaut du connecteur alors que le V2 honorait le réglage.
        stats_max=settings.dashboard_max_tickets,
        ssrf_guard=settings.ssrf_guard_enabled,
    )


def build_llm(settings: Settings, secrets: SecretsPort) -> LlmPort | None:
    """Construit le connecteur LLM selon le fournisseur configuré (clés poussées via l'UI).

    Ollama (local) ne requiert pas de clé. Les autres fournisseurs renvoient None tant
    qu'aucune clé n'est configurée.
    """
    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, secrets, settings)
        provider = cfg.get("llm_provider") or settings.llm_provider
        if provider == "openai_compatible":  # compat ancienne valeur
            provider = "mistral"

        if provider == "anthropic":
            api_key = cfg.get_secret("anthropic_api_key")
            base_url = cfg.get("anthropic_base_url") or settings.anthropic_base_url
            model = cfg.get("anthropic_model") or settings.anthropic_model
        elif provider == "openai":
            api_key = cfg.get_secret("openai_api_key")
            base_url = cfg.get("openai_base_url") or settings.openai_base_url
            model = cfg.get("openai_model") or settings.openai_model
        elif provider == "ollama":
            api_key = "local"  # pas de clé pour un modèle local
            base_url = cfg.get("ollama_base_url") or settings.ollama_base_url
            model = cfg.get("ollama_model") or settings.ollama_model
        else:  # mistral (défaut souverain)
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
        ssrf_guard=settings.ssrf_guard_enabled,
    )


def build_triage_service(
    settings: Settings, secrets: SecretsPort, itsm: ItsmPort | None = None
) -> TriageService | None:
    """Service de triage complet, ou None si le LLM n'est pas configuré.

    Les Fiches techniciens proviennent de la base (éditées via l'UI), pas d'un fichier.
    """
    llm = build_llm(settings, secrets)
    if llm is None:
        return None
    from ..domain import prompting

    with db.session_scope() as session:
        prose = referentials.routing_prose(session)
        cfg = RuntimeConfigService(session, secrets, settings)
        guidance = prompting.build_guidance(
            response_tone=cfg.get("response_tone") or "",
            assistant_name=cfg.get("assistant_name") or "",
            routing_rules=cfg.get("routing_rules") or "",
        )
        retries = cfg.get_int("llm_retries", settings.llm_retries)
        system_prompt = cfg.get("system_prompt") or ""
        default_mode = _safe_mode(cfg.get("execution_mode_default") or settings.execution_mode_default)
        auto_min_confidence = cfg.get_float(
            "auto_min_confidence_default", settings.auto_min_confidence_default
        )
        # Masquage : e-mail + téléphone TOUJOURS dispo. IBAN/carte + secrets
        # (mots de passe, tokens, clés API/cloud) sont une feature SUPPORTER
        # (FEATURE_PII_ADVANCED). Sans licence valide, ils sont forcés à False
        # → NON masqués (un bandeau le signale dans l'UI).
        from ..domain.licensing import FEATURE_PII_ADVANCED
        from ..plugins import build_registry
        from ..services.license_service import LicenseService

        _registry = build_registry()
        _pii_installed = FEATURE_PII_ADVANCED in _registry.installed_features()
        pii_advanced = _pii_installed and LicenseService(cfg).has_feature(FEATURE_PII_ADVANCED)
        # Alerte fail-open : si le code Supporter du masquage avancé est INSTALLÉ mais que
        # la licence est absente/expirée, le masquage IBAN/cartes/secrets/IP-MAC retombe en
        # silence (flags ci-dessous forcés à False) — un client qui l'a acheté comme contrôle
        # de conformité enverrait alors ces données EN CLAIR au LLM. On le signale au niveau
        # WARNING à chaque (re)construction du pipeline (≈ par cycle de polling).
        if _pii_installed and not pii_advanced:
            logger.warning(
                "PII avancé INSTALLÉ mais licence absente/expirée → masquage "
                "IBAN/cartes/secrets/IP-MAC DÉSACTIVÉ (données transmises en clair au LLM). "
                "Renouveler la licence ou suspendre le polling."
            )
        # Provider Supporter (masquage avancé NIR/SIRET/regex) appliqué après le masque
        # de base — None sans licence valide.
        advanced_masker = _registry.provider(FEATURE_PII_ADVANCED) if pii_advanced else None
        mask_flags = {
            "email": cfg.get_bool("mask_email", settings.mask_email),
            "phone": cfg.get_bool("mask_phone", settings.mask_phone),
            "iban": pii_advanced and cfg.get_bool("mask_iban", settings.mask_iban),
            "secret": pii_advanced and cfg.get_bool("mask_secret", settings.mask_secret),
            # IP/MAC : Supporter aussi (pas de toggle dédié — suit pii_advanced).
            "network": pii_advanced,
        }
        # URL GLPI résolue runtime (UI > .env) : sinon le lien du Journal resterait figé à ""
        # quand GLPI est configuré via l'UI et non dans .env.
        glpi_base_url = cfg.get("glpi_base_url") or settings.glpi_base_url
        # Seuil de confiance + plafond de coût : valeurs runtime (réglables via l'UI).
        confidence_threshold = cfg.get_float("confidence_threshold", settings.confidence_threshold)
        cost_cap_eur_per_day = cfg.get_float("cost_cap_eur_per_day", settings.cost_cap_eur_per_day)
    return TriageService(
        itsm=itsm,
        llm=llm,
        settings=settings,
        tech_profiles_prose=prose,
        session_factory=db.session_scope,
        guidance=guidance,
        retries=retries,
        system_prompt=system_prompt,
        default_mode=default_mode,
        auto_min_confidence=auto_min_confidence,
        mask_flags=mask_flags,
        advanced_masker=advanced_masker,
        glpi_base_url=glpi_base_url,
        confidence_threshold=confidence_threshold,
        cost_cap_eur_per_day=cost_cap_eur_per_day,
    )


def _safe_mode(value: str) -> ExecutionMode:
    """Parse le mode par défaut ; toute valeur inconnue retombe sur suggestion (sûr)."""
    try:
        return ExecutionMode(value)
    except ValueError:
        return ExecutionMode.SUGGESTION
