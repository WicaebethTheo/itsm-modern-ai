"""Configuration runtime (FR-22 backend) — secrets poussés via cette API/UI.

⚠️ Les secrets (clés API LLM, tokens GLPI) sont écrits ici (write-only) et stockés
chiffrés (FR-25) ; ils ne sont JAMAIS renvoyés ni lus depuis .env. Le GET expose
les réglages non-secrets et des booléens « *_set » indiquant si un secret est posé.
Protégé par l'authentification locale (FR-24) au niveau du routeur (app.py).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service

router = APIRouter(prefix="/api", tags=["config"])

PROVIDER_PATTERN = "^(mistral|openai|ollama|anthropic)$"


class ConfigView(BaseModel):
    glpi_base_url: str | None = None
    llm_provider: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    openai_base_url: str | None = None
    openai_model: str | None = None
    ollama_base_url: str | None = None
    ollama_model: str | None = None
    anthropic_base_url: str | None = None
    anthropic_model: str | None = None
    confidence_threshold: str | None = None
    cost_cap_eur_per_day: str | None = None
    # Secrets : jamais leur valeur, seulement leur présence.
    glpi_user_token_set: bool
    glpi_app_token_set: bool
    llm_api_key_set: bool
    openai_api_key_set: bool
    anthropic_api_key_set: bool


class ConfigUpdate(BaseModel):
    """Tous les champs sont optionnels ; seuls les fournis sont mis à jour."""

    glpi_base_url: str | None = None
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
    # Secrets (write-only) — Ollama n'a pas de clé.
    glpi_user_token: str | None = None
    glpi_app_token: str | None = None
    llm_api_key: str | None = None  # Mistral
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None


_PLAIN = (
    "glpi_base_url", "llm_provider", "llm_base_url", "llm_model",
    "openai_base_url", "openai_model", "ollama_base_url", "ollama_model",
    "anthropic_base_url", "anthropic_model",
)
_SECRETS = ("glpi_user_token", "glpi_app_token", "llm_api_key", "openai_api_key", "anthropic_api_key")


def _view(cfg: RuntimeConfigService) -> ConfigView:
    return ConfigView(
        **{k: cfg.get(k) for k in _PLAIN},
        confidence_threshold=cfg.get("confidence_threshold"),
        cost_cap_eur_per_day=cfg.get("cost_cap_eur_per_day"),
        glpi_user_token_set=cfg.is_secret_set("glpi_user_token"),
        glpi_app_token_set=cfg.is_secret_set("glpi_app_token"),
        llm_api_key_set=cfg.is_secret_set("llm_api_key"),
        openai_api_key_set=cfg.is_secret_set("openai_api_key"),
        anthropic_api_key_set=cfg.is_secret_set("anthropic_api_key"),
    )


@router.get("/config", response_model=ConfigView)
def get_config(cfg: RuntimeConfigService = Depends(get_config_service)) -> ConfigView:
    return _view(cfg)


@router.post("/config", response_model=ConfigView)
def update_config(
    body: ConfigUpdate, cfg: RuntimeConfigService = Depends(get_config_service)
) -> ConfigView:
    data = body.model_dump(exclude_none=True)
    for key in _PLAIN:
        if key in data:
            cfg.set(key, data[key])
    if "confidence_threshold" in data:
        cfg.set("confidence_threshold", str(data["confidence_threshold"]))
    if "cost_cap_eur_per_day" in data:
        cfg.set("cost_cap_eur_per_day", str(data["cost_cap_eur_per_day"]))
    for key in _SECRETS:
        if key in data:
            cfg.set_secret(key, data[key])
    return _view(cfg)
