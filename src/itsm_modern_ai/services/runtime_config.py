"""Service de configuration runtime — source de vérité des secrets & réglages.

Les SECRETS (clé API LLM, tokens GLPI) sont poussés via l'API/UI (jamais .env) et
stockés chiffrés (FR-25). Les réglages non-secrets peuvent être surchargés en base ;
à défaut, on retombe sur les valeurs d'environnement (`Settings`).

Lecture d'un secret : base uniquement (déchiffré). On ne lit JAMAIS un secret depuis
l'environnement au runtime (exigence produit).
"""

from __future__ import annotations

from sqlmodel import Session

from ..config.credentials import (  # value objects réutilisés par glpi_credentials()
    GlpiCredentials,
    GlpiV2Credentials,
)
from ..config.settings import Settings
from ..persistence.tables import RuntimeConfig
from ..ports.secrets import SecretsPort

# Clés reconnues comme secrets (toujours chiffrées).
SECRET_KEYS = frozenset(
    {
        "glpi_user_token", "glpi_app_token",
        # GLPI API V2 (Beta) — secrets OAuth2 (client_secret + mot de passe du compte technique).
        "glpi_oauth_client_secret", "glpi_oauth_password",
        "llm_api_key", "openai_api_key", "anthropic_api_key",
        "admin_password_hash",
    }
)
# Clés non-secrètes surchargeables en base (sinon valeur d'env via Settings).
PLAIN_KEYS = frozenset(
    {
        # GLPI
        "glpi_base_url", "glpi_verify_tls", "glpi_followup_legacy_9x",
        # GLPI API V2 (Beta) — non-secrets : bascule + URL V2 + identifiants OAuth non sensibles.
        "glpi_api_version", "glpi_v2_base_url",
        "glpi_oauth_client_id", "glpi_oauth_username", "glpi_oauth_scope",
        # Fournisseur LLM
        "llm_provider", "llm_base_url", "llm_model",
        "openai_base_url", "openai_model",
        "ollama_base_url", "ollama_model",
        "anthropic_base_url", "anthropic_model",
        # Moteur
        "confidence_threshold", "cost_cap_eur_per_day", "llm_retries",
        "execution_mode_default", "auto_min_confidence_default",
        # Masquage PII (FR-14)
        "mask_email", "mask_phone", "mask_iban", "mask_secret",
        # Qualité de la suggestion
        "response_tone", "assistant_name", "routing_rules", "system_prompt",
        # Polling
        "polling_enabled", "polling_interval_seconds",
        # Dashboard
        "dashboard_window_days", "anomaly_new_age_hours",
        # Rétention RGPD + état de la dernière purge (lecture seule côté UI pour les last_*).
        "retention_decisions_days", "retention_llm_calls_days",
        "automation_purge_enabled", "automation_purge_hour_utc",
        "automation_purge_last_run_at",
        "automation_purge_last_decisions_deleted",
        "automation_purge_last_llm_calls_deleted",
        "automation_purge_last_run_by",  # audit trail (scheduler | IP de l'admin)
        # Licence Supporter (open-core) — jeton signé Ed25519, auto-portant (non chiffré).
        "license_key",
        # Vérification de mise à jour (opt-in, souverain) — URL du flux de versions.
        "update_check_url",
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
            "glpi_api_version": s.glpi_api_version,
            "glpi_v2_base_url": s.glpi_v2_base_url,
            "glpi_oauth_client_id": s.glpi_oauth_client_id,
            "glpi_oauth_username": s.glpi_oauth_username,
            "glpi_oauth_scope": s.glpi_oauth_scope,
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
            "execution_mode_default": s.execution_mode_default,
            "auto_min_confidence_default": str(s.auto_min_confidence_default),
            "mask_email": str(s.mask_email).lower(),
            "mask_phone": str(s.mask_phone).lower(),
            "mask_iban": str(s.mask_iban).lower(),
            "mask_secret": str(s.mask_secret).lower(),
            "retention_decisions_days": str(s.retention_decisions_days),
            "retention_llm_calls_days": str(s.retention_llm_calls_days),
            "automation_purge_enabled": str(s.automation_purge_enabled).lower(),
            "automation_purge_hour_utc": str(s.automation_purge_hour_utc),
            # État de la dernière exécution : pas de défaut env (None = jamais exécuté).
            "automation_purge_last_run_at": None,
            "automation_purge_last_decisions_deleted": None,
            "automation_purge_last_llm_calls_deleted": None,
            "automation_purge_last_run_by": None,
            # Licence : défaut env optionnel (permet de pré-charger une clé Supporter
            # via LICENSE_KEY, ex. image pré-licenciée). Vide = Community.
            "license_key": self._settings.license_key or None,
            "update_check_url": self._settings.update_check_url or None,
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
        # Anti-SSRF à la sauvegarde : l'URL du flux de versions doit pointer un hôte
        # public routable (rejet loopback / IP privée / metadata cloud), au même titre
        # que les base_url GLPI/LLM validées côté pydantic. Défense en profondeur en plus
        # du garde runtime posé dans le version-checker.
        if key == "update_check_url" and value.strip():
            from ..domain.url_safety import UrlSafetyError, validate_base_url

            try:
                value = validate_base_url(value.strip(), allow_local=False)
            except UrlSafetyError as exc:
                raise ValueError(str(exc)) from exc
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

    def active_glpi_base_url(self) -> str:
        """URL de base GLPI du mode ACTIF (v2 → glpi_v2_base_url, sinon legacy glpi_base_url).

        Sert à dériver le lien web du ticket (Journal/Dashboard) quel que soit le mode.
        """
        if (self.get("glpi_api_version") or "legacy").strip().lower() == "v2":
            return self.get("glpi_v2_base_url") or self.get("glpi_base_url") or ""
        return self.get("glpi_base_url") or ""

    def glpi_v2_credentials(self) -> GlpiV2Credentials:
        """Identifiants de l'API haut-niveau GLPI 11 (OAuth2) — Beta."""
        return GlpiV2Credentials(
            base_url=self.get("glpi_v2_base_url") or self.get("glpi_base_url") or "",
            client_id=self.get("glpi_oauth_client_id") or "",
            client_secret=self.get_secret("glpi_oauth_client_secret") or "",
            username=self.get("glpi_oauth_username") or "",
            password=self.get_secret("glpi_oauth_password") or "",
            verify_tls=self.get_bool("glpi_verify_tls", self._settings.glpi_verify_tls),
            timeout_seconds=self._settings.glpi_timeout_seconds,
            scope=self.get("glpi_oauth_scope") or "api user",
        )
