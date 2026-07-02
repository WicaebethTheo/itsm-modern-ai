"""Réglages applicatifs (pydantic-settings). Vars d'env en UPPER_SNAKE.

⚠️ Les SECRETS (clé API LLM, tokens GLPI) ne sont PLUS lus depuis .env au runtime :
ils sont poussés via l'API/UI de configuration et stockés chiffrés au repos
(cf. services/runtime_config.py + adapters/secrets, FR-25). .env ne porte que des
réglages non-secrets, la master key de chiffrement et l'URL de base de données.

Exception : `llm_api_key` reste lisible ici UNIQUEMENT pour le script de spike CLI
(Epic 1, homelab, sans UI). Le moteur runtime n'utilise PAS ce champ.
"""

from __future__ import annotations

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Persistance (SQLite en pilote ; PostgreSQL en option — Beta, cf. https://docs.itsm-modern-ai.com/).
    # Postgres : DATABASE_URL=postgresql+psycopg://user:pwd@host:5432/itsm (driver psycopg 3,
    # extra `postgres`). Le code est Postgres-ready (UtcDateTime tz-aware, migrations batch).
    database_url: str = "sqlite:///./data/itsm.db"
    # Pool de connexions — appliqué UNIQUEMENT aux bases réseau (non-SQLite). Ignorés en SQLite.
    db_pool_size: int = 5
    db_max_overflow: int = 10
    db_pool_pre_ping: bool = True

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    # Chiffrement des secrets au repos (FR-25). Si absent, une clé est générée et
    # persistée dans data/master.key (durci en Epic 4 : secret monté).
    master_key: str = ""

    # Connecteur LLM — réglages NON-secrets (les clés se poussent via l'UI/API).
    # Fournisseur : "mistral" (souverain, défaut) | "openai" | "ollama" (local) | "anthropic".
    llm_provider: str = "mistral"
    llm_price_input_per_mtok: float = 2.0
    llm_price_output_per_mtok: float = 6.0
    llm_api_key: str = ""  # SPIKE CLI uniquement — pas utilisé par le runtime

    # Mistral EU (souverain, défaut)
    llm_base_url: str = "https://api.mistral.ai/v1"
    llm_model: str = "mistral-large-latest"
    # OpenAI (distinct, non-souverain)
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"
    # Ollama (local, pas de clé)
    ollama_base_url: str = "http://localhost:11434/v1"
    ollama_model: str = "llama3.1"
    # Anthropic (non-souverain, choix explicite de l'opérateur)
    anthropic_base_url: str = "https://api.anthropic.com"
    anthropic_model: str = "claude-sonnet-4-6"
    anthropic_version: str = "2023-06-01"

    # Moteur à garde-fous
    confidence_threshold: float = 0.7  # FR-8 — valeur de départ, à calibrer
    cost_cap_eur_per_day: float = 5.0  # FR-10
    llm_retries: int = 1  # FR-9

    # Mode d'exécution (FR-17). Réglable PAR ENTITÉ dans la console ; ce défaut global
    # s'applique aux entités sans mode explicite. "suggestion" = sûr par défaut
    # (aucune mutation GLPI). semi_auto/full_auto mutent le Ticket — choix explicite.
    execution_mode_default: str = "suggestion"  # suggestion | semi_auto | full_auto
    auto_min_confidence_default: float = 0.9  # 2e seuil strict du mode semi_auto

    # Masquage PII avant l'appel LLM (FR-14). Tous actifs par défaut (défaut sûr).
    # ⚠️ Désactiver un motif envoie cette donnée EN CLAIR au LLM (choix explicite).
    mask_email: bool = True
    mask_phone: bool = True
    mask_iban: bool = True
    mask_secret: bool = True

    # Qualité de la suggestion (impacte le brouillon proposé au demandeur/technicien)
    response_tone: str = "professionnel, courtois et concis"
    assistant_name: str = ""  # signature éventuelle du brouillon
    routing_rules: str = ""  # consignes de routage en langage naturel (données, pas ordres)
    # Prompt système — vide = prompt par défaut intégré. Surcharge avancée (UI).
    system_prompt: str = ""
    system_prompt_max_chars: int = 8000  # garde-fou de longueur

    # Licence Supporter (open-core). Jeton signé Ed25519, vérifié HORS-LIGNE (zéro
    # phone-home). Vide = édition Community. Normalement saisi via l'UI (page Supporter) et
    # stocké en base ; l'env LICENSE_KEY permet de pré-licencier l'image unique.
    license_key: str = ""

    # Vérification de mise à jour. ACTIVÉE par défaut : best-effort, en cache, l'instance
    # lit UNIQUEMENT le dernier numéro de version publié (aucune donnée envoyée). Pour un
    # déploiement air-gap / 100 % hors-ligne : mettre UPDATE_CHECK_URL= (vide) dans .env.
    # Le flux doit renvoyer du JSON {"version": "x.y.z"} (ou {"tag_name": ...}) ou du texte brut.
    update_check_url: str = "https://api.github.com/repos/WicaebethTheo/itsm-modern-ai/releases/latest"
    # Fraîcheur du cache de vérification (s). Le moteur ré-interroge le flux au plus une
    # fois par fenêtre → une release publiée est détectée AUTOMATIQUEMENT sous ce délai,
    # sans redémarrage. Défaut 1 h ; baisser (ex. 60) pour un test quasi immédiat.
    update_check_ttl_seconds: int = 3600

    # UI web (Phase 2) : SPA React buildée servie en statique.
    frontend_dist: str = "frontend/dist"

    # Outils de DEBUG (diagnostics + jeux de test GLPI, dont actions destructives).
    # DÉSACTIVÉ par défaut → inerte en production. À n'activer qu'en labo/test.
    debug_tools_enabled: bool = False

    # Documentation interactive de l'API (Swagger `/docs`, ReDoc `/redoc`, `/openapi.json`).
    # DÉSACTIVÉE par défaut : en prod elle exposerait sans auth le schéma complet des
    # endpoints (et les noms de champs secrets). À n'activer qu'en dev.
    expose_api_docs: bool = False

    # Expiration (absolue) du cookie de session admin, en secondes. Défaut 12 h : au-delà,
    # le cookie n'est plus accepté et l'admin doit se reconnecter (limite le rejeu d'un
    # cookie volé / d'une session oubliée). 0 = pas d'expiration explicite (déconseillé).
    session_max_age_seconds: int = 43200

    # Dashboard inversé (FR-23) — fenêtre glissante et plafond de lecture GLPI.
    dashboard_window_days: int = 7
    dashboard_max_tickets: int = 500
    anomaly_new_age_hours: int = 24  # un Ticket « New » plus vieux que ça = anomalie

    # Rétention RGPD : purge périodique du Journal et des appels LLM. Le job tourne
    # chaque jour à `automation_purge_hour_utc` (UTC) si `automation_purge_enabled`.
    # `*_days <= 0` désactive la purge pour la table concernée (défaut sûr : conserver).
    retention_decisions_days: int = 365
    retention_llm_calls_days: int = 90
    automation_purge_enabled: bool = True
    automation_purge_hour_utc: int = 3

    # Connexion GLPI legacy apirest.php (FR-1) — base_url non-secret ; tokens via UI/API.
    glpi_base_url: str = ""  # ex. https://glpi.exemple.local/apirest.php
    glpi_verify_tls: bool = True
    # Produit ON-PREMISE : le GLPI est presque toujours sur IP/hostname PRIVÉ (RFC1918,
    # `.local`, loopback…). Le garde anti-SSRF (validation lexicale à l'écriture + résolution
    # DNS au runtime) rejetterait alors une cible interne parfaitement légitime et casserait
    # l'install par défaut. Ce flag AUTORISE explicitement un hôte privé pour les SEULS clients
    # GLPI (legacy + V2). La garde stricte reste inchangée pour le LLM et l'update-check (dont
    # les URLs DOIVENT rester publiques, sinon fuite de clé). Défaut True = déploiement on-prem.
    glpi_allow_private_host: bool = Field(
        default=True,
        validation_alias=AliasChoices("GLPI_ALLOW_PRIVATE", "glpi_allow_private_host"),
    )
    glpi_timeout_seconds: float = 30.0
    # Rename TicketFollowup→ITILFollowup (9.x→10.x). True = GLPI 9.x (legacy).
    glpi_followup_legacy_9x: bool = False

    # Choix de l'API GLPI (Beta) : "legacy" = apirest.php (défaut, éprouvé) ;
    # "v2" = API haut-niveau OAuth2 de GLPI 11. En mode v2,
    # GLPI_BASE_URL pointe sur …/api.php/v2.3 et l'auth se fait par client OAuth + compte
    # technique (secrets poussés via l'UI). Le client_secret et le mot de passe sont des
    # secrets chiffrés ; client_id et username sont non-secrets (visibles dans l'UI).
    glpi_api_version: str = "legacy"  # legacy | v2
    # URL de base DISTINCTE pour l'API V2 (ex. https://glpi.exemple.local/api.php/v2.3).
    # Séparée de glpi_base_url (legacy apirest.php) pour que les deux coexistent proprement ;
    # à défaut, on retombe sur glpi_base_url.
    glpi_v2_base_url: str = ""
    glpi_oauth_client_id: str = ""
    glpi_oauth_username: str = ""
    # Scopes OAuth demandés (séparés par un espace). `api` couvre les opérations ITSM
    # (tickets, suivis, référentiels) ; `user` est requis EN PLUS pour /Administration/User/Me
    # (aperçu du compte). Le client OAuth GLPI doit autoriser les scopes demandés.
    glpi_oauth_scope: str = "api user"

    # Polling (FR-2)
    polling_interval_seconds: int = 60
    polling_enabled: bool = True
    polling_max_tickets: int = 200  # garde-fou de pagination par cycle

    # Authentification locale (FR-24). Bootstrap : si défini et aucun hash stocké,
    # le mot de passe est hashé (Argon2) et stocké au premier usage.
    admin_password: str = ""

    # Garde-fou FAIL-CLOSED (durcissement audit 2026-05) : par défaut, si AUCUN mot de
    # passe admin n'est configuré, les endpoints d'admin sont REFUSÉS (401). Mettre ce
    # flag à True ouvre volontairement l'admin sans mot de passe (ancien comportement
    # « pilote réseau interne »). À n'activer qu'en labo/dev, jamais en production.
    dev_open_admin: bool = False

    # Cookie de session : `https_only` (Secure flag). Défaut CODE = True (sûr si aucune
    # config). MAIS l'install (.env.example) livre `SESSION_HTTPS_ONLY=false` car le pilote
    # on-prem tourne généralement en HTTP : avec True sur HTTP, le cookie est ignoré et le
    # login boucle. À repasser à True derrière un reverse-proxy TLS (durcissement prod).
    session_https_only: bool = True

    # Rate-limiting du login (anti brute-force). Limiteur EN MÉMOIRE par IP — adapté
    # au mono-process pilote (pas de HA / pas de store partagé). 0 = désactivé.
    login_max_attempts: int = 5  # échecs tolérés dans la fenêtre avant blocage
    login_window_seconds: int = 300  # fenêtre glissante d'observation des échecs
    login_block_seconds: int = 300  # durée du blocage une fois le seuil franchi

    # Reverse proxy : si True, on lit `X-Forwarded-For` pour déduire l'IP réelle du
    # client (rate-limit login, audit). Défaut sûr : False (pilote/labo sans proxy).
    # À mettre à True UNIQUEMENT derrière un proxy fiable.
    trust_proxy_headers: bool = False

    # Nombre de proxys de CONFIANCE en amont. X-Forwarded-For va de gauche (client,
    # spoofable) à droite (ajouté par TON proxy) → l'IP fiable est la N-ième en partant
    # de la DROITE. 1 = un seul reverse proxy devant le moteur.
    trusted_proxy_hops: int = 1

    # Observabilité — logging structuré (durcissement audit 2026-05). `log_level`
    # pilote le seuil racine ; `log_format=json` produit un log structuré (1 ligne =
    # 1 objet JSON) pour l'agrégation (Loki/ELK), `text` reste lisible en dev.
    # ⚠️ Le format n'inclut AUCUNE PII (pas de corps de requête, pas de query string).
    log_level: str = "INFO"  # DEBUG | INFO | WARNING | ERROR | CRITICAL
    log_format: str = "text"  # text | json

    # Observabilité — métriques Prometheus exposées à GET /metrics (NON authentifié,
    # comme un scrape classique côté réseau interne). Mettre à False pour désactiver
    # complètement l'endpoint et l'instrumentation (défaut : activé).
    metrics_enabled: bool = True
    # Jeton de scrape OPTIONNEL pour `/metrics` (durcissement audit 2026-05). Vide (défaut)
    # → endpoint non authentifié (scrape Prometheus classique, rétrocompatible). Si défini,
    # `/metrics` exige `Authorization: Bearer <token>` (ou en-tête `X-Metrics-Token`) ;
    # toute requête sans le bon jeton reçoit 401. Permet de fermer l'exposition de la
    # volumétrie/latence par route sans casser le scrape par défaut.
    metrics_token: str = ""

    # Garde anti-SSRF au RUNTIME (durcissement audit 2026-05). La validation lexicale des
    # URLs (à l'écriture de config) ne protège pas du DNS rebinding : un hostname public
    # peut résoudre vers une IP interne (169.254.169.254, 10.x, loopback…). Quand activé,
    # chaque appel sortant (LLM, GLPI) résout l'hôte et BLOQUE toute IP privée/loopback/
    # link-local/réservée avant d'émettre la requête (et donc avant toute fuite de token).
    # Localhost reste toléré pour Ollama (allow_local). Défaut sûr : True.
    ssrf_guard_enabled: bool = True


def get_settings() -> Settings:
    return Settings()
