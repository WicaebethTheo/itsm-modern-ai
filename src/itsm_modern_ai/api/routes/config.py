"""Configuration runtime (FR-22 backend) — secrets poussés via cette API/UI.

⚠️ Les secrets (clés API LLM, tokens GLPI) sont écrits ici (write-only) et stockés
chiffrés (FR-25) ; jamais renvoyés ni lus depuis .env. Le GET expose les réglages
non-secrets et des booléens « *_set ». Protégé par l'auth locale (FR-24, app.py).
"""

from __future__ import annotations

from apscheduler.triggers.interval import IntervalTrigger
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator

from ...domain import prompting
from ...domain.url_safety import UrlSafetyError, validate_base_url
from ...services.runtime_config import PLAIN_KEYS, SECRET_KEYS, RuntimeConfigService
from ..deps import get_config_service

router = APIRouter(prefix="/api", tags=["config"])

PROVIDER_PATTERN = "^(mistral|openai|ollama|anthropic)$"
SYSTEM_PROMPT_MAX = 8000  # garde-fou de longueur du prompt système

# Source de vérité des clés : services/runtime_config (pas de duplication).
# Les secrets poussables via cette route = tous les secrets SAUF admin_password_hash,
# qui est géré par le bootstrap d'authentification (FR-24), pas par /api/config.
_PLAIN = PLAIN_KEYS
_SECRETS = SECRET_KEYS - {"admin_password_hash"}


class ConfigView(BaseModel):
    # GLPI
    glpi_base_url: str | None = None
    glpi_verify_tls: str | None = None
    glpi_followup_legacy_9x: str | None = None
    # GLPI API V2 (Beta)
    glpi_api_version: str | None = None
    glpi_v2_base_url: str | None = None
    glpi_oauth_client_id: str | None = None
    glpi_oauth_username: str | None = None
    glpi_oauth_scope: str | None = None
    # LLM
    llm_provider: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    openai_base_url: str | None = None
    openai_model: str | None = None
    ollama_base_url: str | None = None
    ollama_model: str | None = None
    anthropic_base_url: str | None = None
    anthropic_model: str | None = None
    # Moteur
    confidence_threshold: str | None = None
    cost_cap_eur_per_day: str | None = None
    llm_retries: str | None = None
    # Qualité de la suggestion
    response_tone: str | None = None
    assistant_name: str | None = None
    routing_rules: str | None = None
    system_prompt: str | None = None  # surcharge (vide = défaut)
    system_prompt_default: str | None = None  # lecture seule : le prompt intégré
    # Mode d'exécution — défaut global (réglable aussi par entité via /api/modes)
    execution_mode_default: str | None = None
    auto_min_confidence_default: str | None = None
    # Masquage PII avant l'IA (FR-14)
    mask_email: str | None = None
    mask_phone: str | None = None
    mask_iban: str | None = None
    mask_secret: str | None = None
    # Polling
    polling_enabled: str | None = None
    polling_interval_seconds: str | None = None
    # Dashboard
    dashboard_window_days: str | None = None
    anomaly_new_age_hours: str | None = None
    # Secrets : présence seulement.
    glpi_user_token_set: bool
    glpi_app_token_set: bool
    glpi_oauth_client_secret_set: bool
    glpi_oauth_password_set: bool
    llm_api_key_set: bool
    openai_api_key_set: bool
    anthropic_api_key_set: bool


class ConfigUpdate(BaseModel):
    """Tous les champs sont optionnels ; seuls les fournis sont mis à jour."""

    glpi_base_url: str | None = None
    glpi_verify_tls: bool | None = None
    glpi_followup_legacy_9x: bool | None = None
    # GLPI API V2 (Beta)
    glpi_api_version: str | None = Field(default=None, pattern="^(legacy|v2)$")
    glpi_v2_base_url: str | None = None
    glpi_oauth_client_id: str | None = Field(default=None, max_length=500)
    glpi_oauth_username: str | None = Field(default=None, max_length=255)
    glpi_oauth_scope: str | None = Field(default=None, max_length=200)
    llm_provider: str | None = Field(default=None, pattern=PROVIDER_PATTERN)
    llm_base_url: str | None = None
    llm_model: str | None = None
    openai_base_url: str | None = None
    openai_model: str | None = None
    ollama_base_url: str | None = None
    ollama_model: str | None = None
    anthropic_base_url: str | None = None
    anthropic_model: str | None = None
    confidence_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    cost_cap_eur_per_day: float | None = Field(default=None, ge=0.0)
    llm_retries: int | None = Field(default=None, ge=0, le=5)
    response_tone: str | None = Field(default=None, max_length=500)
    assistant_name: str | None = Field(default=None, max_length=200)
    routing_rules: str | None = Field(default=None, max_length=20_000)
    system_prompt: str | None = Field(default=None, max_length=SYSTEM_PROMPT_MAX)
    execution_mode_default: str | None = Field(default=None, pattern="^(suggestion|semi_auto|full_auto)$")
    auto_min_confidence_default: float | None = Field(default=None, ge=0.0, le=1.0)
    mask_email: bool | None = None
    mask_phone: bool | None = None
    mask_iban: bool | None = None
    mask_secret: bool | None = None
    polling_enabled: bool | None = None
    polling_interval_seconds: int | None = Field(default=None, ge=10, le=86_400)
    dashboard_window_days: int | None = Field(default=None, ge=1, le=365)
    anomaly_new_age_hours: int | None = Field(default=None, ge=1, le=720)
    # Secrets (write-only) — Ollama n'a pas de clé.
    glpi_user_token: str | None = None
    glpi_app_token: str | None = None
    # GLPI API V2 (Beta) — secrets OAuth2.
    glpi_oauth_client_secret: str | None = None
    glpi_oauth_password: str | None = None
    llm_api_key: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None

    # ── Validation anti-SSRF des URLs de base (durcissement audit 2026-05) ────────
    # Les URLs publiques (GLPI, Mistral, OpenAI, Anthropic) exigent https:// et un hôte
    # routable (rejet loopback/IP privée/metadata cloud). Ollama est local → http +
    # localhost/IP privée autorisés explicitement.
    @field_validator(
        "glpi_base_url", "glpi_v2_base_url", "llm_base_url", "openai_base_url", "anthropic_base_url"
    )
    @classmethod
    def _validate_public_url(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            return validate_base_url(v, allow_local=False)
        except UrlSafetyError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("ollama_base_url")
    @classmethod
    def _validate_ollama_url(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            return validate_base_url(v, allow_local=True)
        except UrlSafetyError as exc:
            raise ValueError(str(exc)) from exc


def _view(cfg: RuntimeConfigService) -> ConfigView:
    return ConfigView(
        **{k: cfg.get(k) for k in _PLAIN},
        system_prompt_default=prompting.SYSTEM_PROMPT,
        glpi_user_token_set=cfg.is_secret_set("glpi_user_token"),
        glpi_app_token_set=cfg.is_secret_set("glpi_app_token"),
        glpi_oauth_client_secret_set=cfg.is_secret_set("glpi_oauth_client_secret"),
        glpi_oauth_password_set=cfg.is_secret_set("glpi_oauth_password"),
        llm_api_key_set=cfg.is_secret_set("llm_api_key"),
        openai_api_key_set=cfg.is_secret_set("openai_api_key"),
        anthropic_api_key_set=cfg.is_secret_set("anthropic_api_key"),
    )


@router.get("/config", response_model=ConfigView)
def get_config(cfg: RuntimeConfigService = Depends(get_config_service)) -> ConfigView:
    return _view(cfg)


@router.post("/config", response_model=ConfigView)
def update_config(
    body: ConfigUpdate,
    request: Request,
    cfg: RuntimeConfigService = Depends(get_config_service),
) -> ConfigView:
    data = body.model_dump(exclude_none=True)
    for key in _PLAIN:
        if key in data:
            value = data[key]
            cfg.set(key, str(value).lower() if isinstance(value, bool) else str(value))
    for key in _SECRETS:
        if key in data:
            cfg.set_secret(key, data[key])

    # Re-planification à chaud de l'intervalle de polling.
    if "polling_interval_seconds" in data:
        scheduler = getattr(request.app.state, "scheduler", None)
        if scheduler is not None and scheduler.get_job("poll") is not None:
            scheduler.reschedule_job(
                "poll",
                trigger=IntervalTrigger(seconds=max(10, int(data["polling_interval_seconds"]))),
            )
    return _view(cfg)
