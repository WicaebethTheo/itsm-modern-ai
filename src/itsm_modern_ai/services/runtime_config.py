"""Service de configuration runtime — source de vérité des secrets & réglages.

Les SECRETS (clé API LLM, tokens GLPI) sont poussés via l'API/UI (jamais .env) et
stockés chiffrés (FR-25). Les réglages non-secrets peuvent être surchargés en base ;
à défaut, on retombe sur les valeurs d'environnement (`Settings`).

Lecture d'un secret : base uniquement (déchiffré). On ne lit JAMAIS un secret depuis
l'environnement au runtime (exigence produit).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session

from ..config.settings import Settings
from ..persistence.tables import RuntimeConfig
from ..ports.secrets import SecretsPort

# Clés reconnues comme secrets (toujours chiffrées).
SECRET_KEYS = frozenset(
    {
        "glpi_user_token", "glpi_app_token",
        "llm_api_key", "openai_api_key", "anthropic_api_key",
        "admin_password_hash",
    }
)
# Clés non-secrètes surchargeables en base (sinon valeur d'env via Settings).
PLAIN_KEYS = frozenset(
    {
        "glpi_base_url", "llm_provider",
        "llm_base_url", "llm_model",
        "openai_base_url", "openai_model",
        "ollama_base_url", "ollama_model",
        "anthropic_base_url", "anthropic_model",
        "confidence_threshold", "cost_cap_eur_per_day",
    }
)


@dataclass(frozen=True)
class GlpiCredentials:
    base_url: str
    user_token: str
    app_token: str
    verify_tls: bool
    timeout_seconds: float
    followup_legacy_9x: bool

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url and self.user_token)


class RuntimeConfigService:
    def __init__(self, session: Session, secrets: SecretsPort, settings: Settings) -> None:
        self._session = session
        self._secrets = secrets
        self._settings = settings

    @property
    def settings(self) -> Settings:
        return self._settings

    # ── lecture ───────────────────────────────────────────────────────────────
    def _row(self, key: str) -> RuntimeConfig | None:
        return self._session.get(RuntimeConfig, key)

    def get_secret(self, key: str) -> str | None:
        """Valeur en clair d'un secret (base uniquement). None si non configuré."""
        if key not in SECRET_KEYS:
            raise ValueError(f"{key} n'est pas un secret connu")
        row = self._row(key)
        if row is None or not row.value:
            return None
        return self._secrets.decrypt(row.value)

    def is_secret_set(self, key: str) -> bool:
        row = self._row(key)
        return row is not None and bool(row.value)

    def get(self, key: str) -> str | None:
        """Réglage non-secret : surcharge base, sinon valeur d'environnement."""
        row = self._row(key)
        if row is not None and row.value != "":
            return row.value
        return self._env_default(key)

    def _env_default(self, key: str) -> str | None:
        defaults = {
            "glpi_base_url": self._settings.glpi_base_url,
            "llm_provider": self._settings.llm_provider,
            "llm_base_url": self._settings.llm_base_url,
            "llm_model": self._settings.llm_model,
            "openai_base_url": self._settings.openai_base_url,
            "openai_model": self._settings.openai_model,
            "ollama_base_url": self._settings.ollama_base_url,
            "ollama_model": self._settings.ollama_model,
            "anthropic_base_url": self._settings.anthropic_base_url,
            "anthropic_model": self._settings.anthropic_model,
            "confidence_threshold": str(self._settings.confidence_threshold),
            "cost_cap_eur_per_day": str(self._settings.cost_cap_eur_per_day),
        }
        return defaults.get(key)

    # ── écriture ────────────────────────────────────────────────────────────────
    def set_secret(self, key: str, plaintext: str) -> None:
        if key not in SECRET_KEYS:
            raise ValueError(f"{key} n'est pas un secret connu")
        token = self._secrets.encrypt(plaintext) if plaintext else ""
        self._upsert(key, token, is_secret=True)

    def set(self, key: str, value: str) -> None:
        if key not in PLAIN_KEYS:
            raise ValueError(f"{key} n'est pas un réglage surchargeable")
        self._upsert(key, value, is_secret=False)

    def _upsert(self, key: str, value: str, *, is_secret: bool) -> None:
        row = self._row(key)
        if row is None:
            row = RuntimeConfig(key=key, value=value, is_secret=is_secret)
        else:
            row.value = value
            row.is_secret = is_secret
        self._session.add(row)
        self._session.commit()

    # ── vues typées ──────────────────────────────────────────────────────────────
    def glpi_credentials(self) -> GlpiCredentials:
        return GlpiCredentials(
            base_url=self.get("glpi_base_url") or "",
            user_token=self.get_secret("glpi_user_token") or "",
            app_token=self.get_secret("glpi_app_token") or "",
            verify_tls=self._settings.glpi_verify_tls,
            timeout_seconds=self._settings.glpi_timeout_seconds,
            followup_legacy_9x=self._settings.glpi_followup_legacy_9x,
        )
