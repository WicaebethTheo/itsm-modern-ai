"""Service de configuration runtime — source de vérité des secrets & réglages.

Les SECRETS (clé API LLM, tokens GLPI) sont poussés via l'API/UI (jamais .env) et
stockés chiffrés (FR-25). Les réglages non-secrets peuvent être surchargés en base ;
à défaut, on retombe sur les valeurs d'environnement (`Settings`).

Lecture d'un secret : base uniquement (déchiffré). On ne lit JAMAIS un secret depuis
l'environnement au runtime (exigence produit).
"""

from __future__ import annotations

from sqlmodel import Session

from ..config.credentials import GlpiCredentials  # value object réutilisé par glpi_credentials()
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
        # GLPI
        "glpi_base_url", "glpi_verify_tls", "glpi_followup_legacy_9x",
        # Fournisseur LLM
        "llm_provider", "llm_base_url", "llm_model",
        "openai_base_url", "openai_model",
        "ollama_base_url", "ollama_model",
        "anthropic_base_url", "anthropic_model",
        # Moteur
        "confidence_threshold", "cost_cap_eur_per_day", "llm_retries",
        "execution_mode_default", "auto_min_confidence_default",
        # Qualité de la suggestion
        "response_tone", "assistant_name", "routing_rules", "system_prompt",
        # Polling
        "polling_enabled", "polling_interval_seconds",
        # Dashboard
        "dashboard_window_days", "anomaly_new_age_hours",
    }
)


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

    def get_bool(self, key: str, default: bool = False) -> bool:
        v = self.get(key)
        if v is None:
            return default
        return v.strip().lower() in ("1", "true", "yes", "on", "vrai")

    def get_int(self, key: str, default: int = 0) -> int:
        try:
            return int(float(self.get(key) or default))
        except (TypeError, ValueError):
            return default

    def get_float(self, key: str, default: float = 0.0) -> float:
        try:
            return float(self.get(key) or default)
        except (TypeError, ValueError):
            return default

    def _env_default(self, key: str) -> str | None:
        s = self._settings
        defaults = {
            "glpi_base_url": s.glpi_base_url,
            "glpi_verify_tls": str(s.glpi_verify_tls).lower(),
            "glpi_followup_legacy_9x": str(s.glpi_followup_legacy_9x).lower(),
            "llm_provider": s.llm_provider,
            "llm_base_url": s.llm_base_url,
            "llm_model": s.llm_model,
            "openai_base_url": s.openai_base_url,
            "openai_model": s.openai_model,
            "ollama_base_url": s.ollama_base_url,
            "ollama_model": s.ollama_model,
            "anthropic_base_url": s.anthropic_base_url,
            "anthropic_model": s.anthropic_model,
            "confidence_threshold": str(s.confidence_threshold),
            "cost_cap_eur_per_day": str(s.cost_cap_eur_per_day),
            "llm_retries": str(s.llm_retries),
            "response_tone": s.response_tone,
            "assistant_name": s.assistant_name,
            "routing_rules": s.routing_rules,
            "system_prompt": s.system_prompt,
            "polling_enabled": str(s.polling_enabled).lower(),
            "polling_interval_seconds": str(s.polling_interval_seconds),
            "dashboard_window_days": str(s.dashboard_window_days),
            "anomaly_new_age_hours": str(s.anomaly_new_age_hours),
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
            verify_tls=self.get_bool("glpi_verify_tls", self._settings.glpi_verify_tls),
            timeout_seconds=self._settings.glpi_timeout_seconds,
            followup_legacy_9x=self.get_bool(
                "glpi_followup_legacy_9x", self._settings.glpi_followup_legacy_9x
            ),
        )
