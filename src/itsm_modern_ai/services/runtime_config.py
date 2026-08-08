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
from ..persistence.tables import AuditLog, RuntimeConfig
from ..ports.secrets import SecretsPort

# Sentinelle de DÉSACTIVATION explicite d'un réglage surchargeable. Une valeur vide ("")
# est traitée comme « non surchargé » → repli sur l'env. Or, pour `license_key`, un DELETE
# doit RE-VERROUILLER même si LICENSE_KEY est présent dans l'env (sinon on retombe Supporter).
# Ce marqueur stocké signifie « retiré volontairement : NE PAS retomber sur l'env ».
CLEARED_SENTINEL = "__cleared__"

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
        # Tarifs €/Mtok : surchargeables à chaud, sinon le cost cap est faux après une
        # bascule de fournisseur via l'UI (chaque provider a ses propres tarifs).
        "llm_price_input_per_mtok", "llm_price_output_per_mtok",
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
        # État du DERNIER cycle de polling (observabilité). `PollStats` était jeté après
        # un simple log : impossible de répondre à « pourquoi aucun ticket n'est trié ? »
        # sans accéder aux logs du conteneur. Écrit par le poller, lu par /api/status.
        "poll_last_run_at", "poll_last_fetched", "poll_last_processed",
        "poll_last_skipped_done", "poll_last_skipped_scope", "poll_last_errors",
        "poll_last_error_message",
        # Licence Supporter (open-core) — jeton signé Ed25519, auto-portant (non chiffré).
        "license_key",
        # Vérification de mise à jour (opt-in, souverain) — URL du flux de versions.
        "update_check_url",
    }
)

# ── Journal d'audit (imputabilité) ────────────────────────────────────────────────
# Initiateur par défaut quand l'appelant n'a pas d'IP à fournir (job planifié, CLI).
AUDIT_ACTOR_SYSTEM = "system"
# Marqueur substitué à toute valeur qu'on refuse de recopier dans l'audit.
AUDIT_MASK = "***"
# Clés NON secrètes mais sensibles : leur valeur ne doit pas être recopiée en clair dans
# l'audit. `license_key` est un jeton signé qui déverrouille les features Supporter :
# le recopier reviendrait à en distribuer une copie utilisable à quiconque lit l'audit.
SENSITIVE_PLAIN_KEYS = frozenset({"license_key"})
# Écritures d'ÉTAT MACHINE (télémétrie), volontairement NON auditées : elles sont produites
# par le moteur à chaque cycle (polling) ou à chaque purge, pas par une décision d'admin.
# Les auditer noierait les vraies actions d'administration sous des milliers de lignes de
# bruit — un journal d'audit illisible ne vaut pas mieux qu'un journal absent.
AUDIT_SILENT_PREFIXES = ("poll_last_", "automation_purge_last_")
# Bornage de ce qu'on recopie (un `system_prompt` fait jusqu'à 8000 caractères ; l'audit
# doit dire QUE la valeur a changé, pas archiver le corpus complet à chaque frappe).
AUDIT_VALUE_MAX_CHARS = 500

# Clé RÉSERVÉE (hors PLAIN_KEYS/SECRET_KEYS, donc non exposée ni écrivable via /api/config) :
# compteur de génération des sessions admin. Toute session porte la valeur au moment du
# login ; incrémenter ce compteur invalide instantanément TOUS les cookies déjà émis.
SESSION_VERSION_KEY = "session_version"


class RuntimeConfigService:
    def __init__(
        self,
        session: Session,
        secrets: SecretsPort,
        settings: Settings,
        *,
        actor: str = AUDIT_ACTOR_SYSTEM,
    ) -> None:
        self._session = session
        self._secrets = secrets
        self._settings = settings
        # Initiateur par défaut des écritures auditées. Câblé à l'IP du client par
        # `api/deps.config_service_from_request` ; reste "system" pour le scheduler/CLI.
        # Paramètre nommé avec défaut : aucun appelant existant n'est cassé.
        self._actor = actor or AUDIT_ACTOR_SYSTEM

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
        """Réglage non-secret : surcharge base, sinon valeur d'environnement.

        Cas particulier `license_key` : la sentinelle `CLEARED_SENTINEL` signifie « licence
        retirée volontairement » → on renvoie None SANS retomber sur l'env (sinon un DELETE
        /api/license re-verrouillerait pas quand LICENSE_KEY est défini dans l'env).
        """
        row = self._row(key)
        if row is not None:
            if key == "license_key" and row.value == CLEARED_SENTINEL:
                return None
            if row.value != "":
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
            "llm_price_input_per_mtok": str(s.llm_price_input_per_mtok),
            "llm_price_output_per_mtok": str(s.llm_price_output_per_mtok),
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
    def set_secret(self, key: str, plaintext: str, *, by: str | None = None) -> None:
        """Écrit un secret chiffré. `by` = initiateur (IP admin) pour le journal d'audit.

        Même convention que `retention.record_last_run(by=...)` : optionnel, et à défaut on
        retombe sur l'`actor` du service (l'IP câblée par la dépendance FastAPI, sinon
        "system"). Le service n'a pas accès à la requête HTTP : c'est l'appelant qui sait.
        """
        if key not in SECRET_KEYS:
            raise ValueError(f"{key} n'est pas un secret connu")
        # Ancienne valeur JAMAIS déchiffrée pour l'audit : on ne consigne que la PRÉSENCE
        # (et déchiffrer échouerait de toute façon après une rotation de MASTER_KEY).
        old = AUDIT_MASK if self.is_secret_set(key) else ""
        token = self._secrets.encrypt(plaintext) if plaintext else ""
        self._upsert(key, token, is_secret=True)
        self._audit("config.set_secret", key, old, AUDIT_MASK if plaintext else "", by)

    def set(self, key: str, value: str, *, by: str | None = None) -> None:
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
        # Ancienne valeur EFFECTIVE (surcharge base, sinon env) : c'est celle que le moteur
        # appliquait réellement avant le changement — la seule qui rende l'audit lisible.
        old = self.get(key) or ""
        self._upsert(key, value, is_secret=False)
        self._audit("config.set", key, old, value, by)

    def _upsert(self, key: str, value: str, *, is_secret: bool) -> None:
        row = self._row(key)
        if row is None:
            row = RuntimeConfig(key=key, value=value, is_secret=is_secret)
        else:
            row.value = value
            row.is_secret = is_secret
        self._session.add(row)
        self._session.commit()

    # ── journal d'audit ─────────────────────────────────────────────────────────
    def record_action(
        self, action: str, key: str, old: str = "", new: str = "", *, by: str | None = None
    ) -> None:
        """Consigne une action d'administration qui ne passe PAS par `set`/`set_secret`.

        `set`/`set_secret` couvrent tout ce qui vit dans `runtime_config`, mais certaines
        décisions d'admin sont stockées ailleurs — au premier rang desquelles le **mode
        d'exécution PAR ENTITÉ** (`referential_cache`), qui autorise l'IA à muter les
        Tickets et à répondre PUBLIQUEMENT au demandeur. C'est précisément le genre de
        bascule qu'un RSSI veut pouvoir imputer, et elle n'aurait laissé aucune trace.

        Réservé aux écritures hors `runtime_config` : pour tout le reste, passer par
        `set`/`set_secret`, qui tracent automatiquement et ne peuvent pas être oubliés.
        """
        self._audit(action, key, old, new, by)

    def _audit(self, action: str, key: str, old: str, new: str, by: str | None) -> None:
        """Consigne une écriture de configuration (imputabilité — cf. `tables.AuditLog`).

        Placé ici et non dans les routes : `set`/`set_secret` sont le point de passage
        UNIQUE de toute écriture de config (API, licence, automations, reset GLPI), donc
        aucun chemin d'écriture ne peut « oublier » de tracer.
        """
        if key.startswith(AUDIT_SILENT_PREFIXES):
            return  # état machine (télémétrie) — pas une action d'administration
        if key in SENSITIVE_PLAIN_KEYS:
            # Sensible sans être « secret » au sens du chiffrement : on ne garde que
            # la présence (posé / retiré), jamais le jeton exploitable.
            old = AUDIT_MASK if old else ""
            new = AUDIT_MASK if new and new != CLEARED_SENTINEL else ""
        self._session.add(
            AuditLog(
                actor=(by or self._actor or AUDIT_ACTOR_SYSTEM)[:200],
                action=action,
                key=key,
                old_value=old[:AUDIT_VALUE_MAX_CHARS],
                new_value=new[:AUDIT_VALUE_MAX_CHARS],
            )
        )
        self._session.commit()

    # ── révocation des sessions admin ───────────────────────────────────────────
    def session_version(self) -> int:
        """Génération courante des sessions admin (0 si jamais incrémentée).

        Portée dans le cookie signé au login et revérifiée à chaque requête : c'est ce qui
        rend une session RÉVOCABLE sans store partagé (un simple entier en base suffit,
        l'instance étant mono-process — cf. le limiteur de login, même hypothèse).
        """
        row = self._row(SESSION_VERSION_KEY)
        if row is None or not row.value:
            return 0
        try:
            return int(row.value)
        except ValueError:
            # Valeur corrompue : on repart de 0 plutôt que de crasher le login. Le pire cas
            # est une invalidation supplémentaire des cookies, jamais une acceptation.
            return 0

    def bump_session_version(self) -> int:
        """Incrémente la génération : TOUS les cookies déjà émis deviennent invalides.

        Appelé au logout ET à tout changement de mot de passe admin. Sans ça, la seule
        parade à un cookie volé était de changer `MASTER_KEY` — ce qui rend illisibles
        TOUS les secrets chiffrés et verrouille la console. Écrit via `_upsert` (et non
        `set`) : la clé est réservée, hors `PLAIN_KEYS`, donc ni exposée ni écrivable par
        `/api/config`, et le bruit login/logout ne pollue pas le journal d'audit.
        """
        new = self.session_version() + 1
        self._upsert(SESSION_VERSION_KEY, str(new), is_secret=False)
        return new

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
