"""Réglages applicatifs (pydantic-settings). Vars d'env en UPPER_SNAKE.

⚠️ Les SECRETS (clé API LLM, tokens GLPI) ne sont PLUS lus depuis .env au runtime :
ils sont poussés via l'API/UI de configuration et stockés chiffrés au repos
(cf. services/runtime_config.py + adapters/secrets, FR-25). .env ne porte que des
réglages non-secrets, la master key de chiffrement et l'URL de base de données.

Exception : `llm_api_key` reste lisible ici UNIQUEMENT pour le script de spike CLI
(Epic 1, homelab, sans UI). Le moteur runtime n'utilise PAS ce champ.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Persistance (SQLite en pilote, Postgres-ready)
    database_url: str = "sqlite:///./data/itsm.db"

    # Chiffrement des secrets au repos (FR-25). Si absent, une clé est générée et
    # persistée dans data/master.key (durci en Epic 4 : secret monté).
    master_key: str = ""

    # Connecteur LLM — réglages NON-secrets (la clé se pousse via l'UI/API).
    llm_base_url: str = "https://api.mistral.ai/v1"
    llm_model: str = "mistral-large-latest"
    llm_price_input_per_mtok: float = 2.0
    llm_price_output_per_mtok: float = 6.0
    llm_api_key: str = ""  # SPIKE CLI uniquement — pas utilisé par le runtime

    # Moteur à garde-fous
    confidence_threshold: float = 0.7  # FR-8 — valeur de départ, à calibrer
    cost_cap_eur_per_day: float = 5.0  # FR-10

    # Connexion GLPI legacy apirest.php (FR-1) — base_url non-secret ; tokens via UI/API.
    glpi_base_url: str = ""  # ex. https://glpi.exemple.local/apirest.php
    glpi_verify_tls: bool = True
    glpi_timeout_seconds: float = 30.0
    # Rename TicketFollowup→ITILFollowup (9.x→10.x). True = GLPI 9.x (legacy).
    glpi_followup_legacy_9x: bool = False

    # Polling (FR-2)
    polling_interval_seconds: int = 60
    polling_enabled: bool = True
    polling_max_tickets: int = 200  # garde-fou de pagination par cycle


def get_settings() -> Settings:
    return Settings()
