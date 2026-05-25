"""Réglages applicatifs (pydantic-settings). Vars d'env en UPPER_SNAKE."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Connecteur LLM (FR-11/13)
    llm_base_url: str = "https://api.mistral.ai/v1"
    llm_model: str = "mistral-large-latest"
    llm_api_key: str = ""
    llm_price_input_per_mtok: float = 2.0
    llm_price_output_per_mtok: float = 6.0

    # Moteur à garde-fous
    confidence_threshold: float = 0.7  # FR-8 — valeur de départ, à calibrer
    cost_cap_eur_per_day: float = 5.0  # FR-10

    # GLPI (Epic 2 — non utilisé par le spike)
    glpi_base_url: str = ""
    glpi_app_token: str = ""
    glpi_user_token: str = ""
    polling_interval_seconds: int = 60


def get_settings() -> Settings:
    return Settings()
