"""Configuration runtime (FR-22 backend) — secrets poussés via cette API/UI.

⚠️ Les secrets (clé API LLM, tokens GLPI) sont écrits ici (write-only) et stockés
chiffrés (FR-25) ; ils ne sont JAMAIS renvoyés ni lus depuis .env. Le GET expose
les réglages non-secrets et des booléens « *_set » indiquant si un secret est posé.

NOTE : cet endpoint sera protégé par l'authentification locale en Epic 4 (FR-24).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service

router = APIRouter(prefix="/api", tags=["config"])


class ConfigView(BaseModel):
    glpi_base_url: str | None = None
    llm_provider: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    anthropic_base_url: str | None = None
    anthropic_model: str | None = None
    confidence_threshold: str | None = None
    cost_cap_eur_per_day: str | None = None
    # Secrets : jamais leur valeur, seulement leur présence.
    glpi_user_token_set: bool
    glpi_app_token_set: bool
    llm_api_key_set: bool
    anthropic_api_key_set: bool


class ConfigUpdate(BaseModel):
    """Tous les champs sont optionnels ; seuls les fournis sont mis à jour."""

    glpi_base_url: str | None = None
    llm_provider: str | None = Field(default=None, pattern="^(openai_compatible|anthropic)$")
    llm_base_url: str | None = None
    llm_model: str | None = None
    anthropic_base_url: str | None = None
    anthropic_model: str | None = None
    confidence_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    cost_cap_eur_per_day: float | None = Field(default=None, ge=0.0)
    # Secrets (write-only)
    glpi_user_token: str | None = None
    glpi_app_token: str | None = None
    llm_api_key: str | None = None
    anthropic_api_key: str | None = None


def _view(cfg: RuntimeConfigService) -> ConfigView:
    return ConfigView(
        glpi_base_url=cfg.get("glpi_base_url"),
        llm_provider=cfg.get("llm_provider"),
        llm_base_url=cfg.get("llm_base_url"),
        llm_model=cfg.get("llm_model"),
        anthropic_base_url=cfg.get("anthropic_base_url"),
        anthropic_model=cfg.get("anthropic_model"),
        confidence_threshold=cfg.get("confidence_threshold"),
        cost_cap_eur_per_day=cfg.get("cost_cap_eur_per_day"),
        glpi_user_token_set=cfg.is_secret_set("glpi_user_token"),
        glpi_app_token_set=cfg.is_secret_set("glpi_app_token"),
        llm_api_key_set=cfg.is_secret_set("llm_api_key"),
        anthropic_api_key_set=cfg.is_secret_set("anthropic_api_key"),
    )


@router.get("/config", response_model=ConfigView)
def get_config(cfg: RuntimeConfigService = Depends(get_config_service)) -> ConfigView:
    return _view(cfg)


@router.post("/config", response_model=ConfigView)
def update_config(
    body: ConfigUpdate, cfg: RuntimeConfigService = Depends(get_config_service)
) -> ConfigView:
    if body.glpi_base_url is not None:
        cfg.set("glpi_base_url", body.glpi_base_url)
    if body.llm_provider is not None:
        cfg.set("llm_provider", body.llm_provider)
    if body.llm_base_url is not None:
        cfg.set("llm_base_url", body.llm_base_url)
    if body.llm_model is not None:
        cfg.set("llm_model", body.llm_model)
    if body.anthropic_base_url is not None:
        cfg.set("anthropic_base_url", body.anthropic_base_url)
    if body.anthropic_model is not None:
        cfg.set("anthropic_model", body.anthropic_model)
    if body.confidence_threshold is not None:
        cfg.set("confidence_threshold", str(body.confidence_threshold))
    if body.cost_cap_eur_per_day is not None:
        cfg.set("cost_cap_eur_per_day", str(body.cost_cap_eur_per_day))
    if body.glpi_user_token is not None:
        cfg.set_secret("glpi_user_token", body.glpi_user_token)
    if body.glpi_app_token is not None:
        cfg.set_secret("glpi_app_token", body.glpi_app_token)
    if body.llm_api_key is not None:
        cfg.set_secret("llm_api_key", body.llm_api_key)
    if body.anthropic_api_key is not None:
        cfg.set_secret("anthropic_api_key", body.anthropic_api_key)
    return _view(cfg)
