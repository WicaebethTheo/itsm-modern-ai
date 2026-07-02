"""Application FastAPI headless + lifespan (démarrage du scheduler de polling)."""

from __future__ import annotations

import logging
import secrets as _secrets
import time
from contextlib import asynccontextmanager
from datetime import UTC
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import Depends, FastAPI
from starlette.middleware.sessions import SessionMiddleware

from ..config.settings import Settings, get_settings
from ..persistence import db
from ..scheduler.poller import TriagePoller
from ..services.whitelist_cache import WhitelistCache
from .ratelimit import LoginRateLimiter
from .runtime import build_connector, build_triage_service, make_secrets_box
from .security import require_auth

logger = logging.getLogger("itsm.app")


def _poll_enabled(app: FastAPI) -> bool:
    """Lecture runtime de l'activation du polling (pause/reprise à chaud via l'UI)."""
    from ..persistence import db as _db
    from ..services.runtime_config import RuntimeConfigService

    settings: Settings = app.state.settings
    with _db.session_scope() as session:
        return RuntimeConfigService(session, app.state.secrets_box, settings).get_bool(
            "polling_enabled", settings.polling_enabled
        )


async def _run_poll_cycle(app: FastAPI) -> None:
    """Job planifié : (re)construit connecteur + triage depuis la config et poll une fois."""
    settings: Settings = app.state.settings
    if not _poll_enabled(app):
        logger.info("poll: désactivé (polling_enabled=false) — cycle ignoré")
        return
    connector = build_connector(settings, app.state.secrets_box)
    if connector is None:
        logger.info("poll: GLPI non configuré (URL/token à pousser via /api/config) — cycle ignoré")
        return
    # Le moteur (Epic 3) n'est branché que si le LLM est configuré (clé poussée via l'UI).
    triage = build_triage_service(settings, app.state.secrets_box, connector)
    handler = triage.handle if triage is not None else None
    if handler is None:
        logger.info("poll: LLM non configuré — lecture seule (aucune suggestion déposée)")
    # Whitelist = périmètre EFFECTIF (catégories/techniciens/groupes sélectionnés en base),
    # pas tout GLPI. Le scan GLPI alimente ce périmètre via /api/glpi/sync.
    def _effective_refs():
        from ..persistence import db as _db
        from ..services import referentials as _refs

        with _db.session_scope() as session:
            return _refs.effective_referentials(session)

    poller = TriagePoller(
        connector,
        app.state.whitelist_cache,
        handler=handler,
        referentials_loader=_effective_refs,
    )
    await poller.poll_once()


async def _run_purge_cycle(app: FastAPI) -> None:
    """Job planifié : purge RGPD du Journal + appels LLM si l'automation est activée.

    Échec encapsulé (`try/except`) pour ne pas casser le scheduler et tracer le contexte
    métier (fenêtres, durée), conforme à l'observabilité attendue (audit DPO).
    """
    from ..persistence import db as _db
    from ..services import retention
    from ..services.runtime_config import RuntimeConfigService

    settings: Settings = app.state.settings
    started = time.perf_counter()
    try:
        with _db.session_scope() as session:
            cfg = RuntimeConfigService(session, app.state.secrets_box, settings)
            if not cfg.get_bool("automation_purge_enabled", settings.automation_purge_enabled):
                logger.info("purge: désactivée (automation_purge_enabled=false) — cycle ignoré")
                return
            decisions_days = cfg.get_int("retention_decisions_days", settings.retention_decisions_days)
            llm_days = cfg.get_int("retention_llm_calls_days", settings.retention_llm_calls_days)
        with _db.session_scope() as session:
            result = retention.purge_now(
                session, decisions_days=decisions_days, llm_calls_days=llm_days
            )
        with _db.session_scope() as session:
            cfg = RuntimeConfigService(session, app.state.secrets_box, settings)
            retention.record_last_run(cfg, result, by="scheduler")
        logger.info(
            "purge: %d décision(s), %d appel(s) LLM supprimés (fenêtres %dj/%dj, durée %.2fs)",
            result.decisions_deleted, result.llm_calls_deleted, decisions_days, llm_days,
            time.perf_counter() - started,
        )
    except Exception:
        logger.exception("purge: échec après %.2fs", time.perf_counter() - started)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    db.init_engine(
        settings.database_url,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_pre_ping=settings.db_pool_pre_ping,
    )
    db.create_all()  # Alembic reste la source de vérité pour les évolutions
    app.state.secrets_box = make_secrets_box(settings)
    app.state.whitelist_cache = WhitelistCache()

    # Open-core : enregistre les features Supporter intégrées + découvre les plugins externes
    # (entry points). Les features sont livrées dans l'image mais restent verrouillées tant
    # qu'aucune licence valide ne les autorise.
    from ..plugins import build_registry

    app.state.plugin_registry = build_registry()

    # Intervalle initial depuis la config runtime (modifiable à chaud via /api/config).
    from ..services.runtime_config import RuntimeConfigService

    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, app.state.secrets_box, settings)
        interval = cfg.get_int("polling_interval_seconds", settings.polling_interval_seconds)
        purge_hour = cfg.get_int("automation_purge_hour_utc", settings.automation_purge_hour_utc)

    # Scheduler pinné UTC : cohérent avec `_utcnow` (persistence) et avec le nom
    # `automation_purge_hour_utc`. Évite tout drift DST si l'hôte n'est pas en UTC.
    scheduler = AsyncIOScheduler(timezone=UTC)
    # Le job tourne toujours ; l'activation est décidée à l'exécution (_poll_enabled).
    scheduler.add_job(
        _run_poll_cycle,
        trigger=IntervalTrigger(seconds=max(10, interval)),
        args=[app],
        id="poll",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    # Purge RGPD quotidienne (heure UTC réglable via /api/automations/retention).
    # `misfire_grace_time=3600` : tolère 1 h de retard après un crash/redémarrage,
    # sinon `coalesce=True` ne suffit pas et la purge du jour serait silencieusement sautée.
    scheduler.add_job(
        _run_purge_cycle,
        trigger=CronTrigger(hour=max(0, min(23, purge_hour)), minute=0, timezone=UTC),
        args=[app],
        id="purge",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )
    scheduler.start()
    app.state.scheduler = scheduler
    logger.info("démarré (interval=%ss, purge_hour=%sh UTC)", interval, purge_hour)
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)


def create_app(settings: Settings | None = None) -> FastAPI:
    from .. import __version__
    from .routes import auth as auth_routes
    from .routes import automations as automations_routes
    from .routes import config as config_routes
    from .routes import cost as cost_routes
    from .routes import debug as debug_routes
    from .routes import decisions as decisions_routes
    from .routes import export as export_routes
    from .routes import glpi as glpi_routes
    from .routes import health as health_routes
    from .routes import insights as insights_routes
    from .routes import license as license_routes
    from .routes import privacy as privacy_routes
    from .routes import referentials as referentials_routes
    from .routes import sandbox as sandbox_routes
    from .routes import status as status_routes
    from .routes import version as version_routes
    from .spa import mount_spa

    settings = settings or get_settings()

    # Observabilité : init logging centralisée AVANT toute autre chose, pour que les
    # logs de démarrage (lifespan, scheduler) sortent au format/niveau configurés.
    from ..config.logging import configure_logging

    configure_logging(level=settings.log_level, fmt=settings.log_format)

    # Docs interactives (`/docs`, `/redoc`, `/openapi.json`) DÉSACTIVÉES par défaut :
    # en prod elles exposeraient sans auth le schéma complet de l'API (noms des champs
    # secrets compris). On ne les monte qu'en dev (`EXPOSE_API_DOCS=true`).
    _docs_on = settings.expose_api_docs
    app = FastAPI(
        title="ITSM Modern AI — moteur de triage (headless)",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if _docs_on else None,
        redoc_url="/redoc" if _docs_on else None,
        openapi_url="/openapi.json" if _docs_on else None,
    )
    app.state.settings = settings

    # Limiteur anti brute-force du login (en mémoire, par IP — FR-24 durci).
    app.state.login_limiter = LoginRateLimiter(
        max_attempts=settings.login_max_attempts,
        window_seconds=settings.login_window_seconds,
        block_seconds=settings.login_block_seconds,
    )

    # Session signée pour l'auth locale (FR-24). Durcissement audit 2026-05 :
    # le secret de session est DÉRIVÉ (HKDF, info=b"session-signing") de la MÊME source
    # de clé que la boîte à secrets (MASTER_KEY env OU data/master.key persistée). Il est
    # donc DISTINCT de la clé Fernet ET STABLE entre redémarrages, même si MASTER_KEY est
    # vide (la clé fichier persiste). `_secrets.token_urlsafe` n'est qu'un ultime filet
    # (clé éphémère) si la dérivation échoue, jamais le cas nominal.
    try:
        session_secret = make_secrets_box(settings).derive_key(b"session-signing").hex()
    except Exception:  # pragma: no cover - filet défensif
        logger.warning("dérivation du secret de session échouée — secret éphémère (sessions volatiles)")
        session_secret = _secrets.token_urlsafe(32)
    # En-têtes de sécurité sur TOUTES les réponses (nosniff, anti-framing, referrer,
    # CSP sur le HTML de la SPA). HSTS seulement derrière TLS (session_https_only) :
    # le poser sur le pilote HTTP rendrait l'instance injoignable après un essai HTTPS.
    from .security_headers import SecurityHeadersMiddleware

    app.add_middleware(SecurityHeadersMiddleware, hsts=settings.session_https_only)

    app.add_middleware(
        SessionMiddleware,
        secret_key=session_secret,
        # `lax` : compromis usuel (le cookie suit les navigations top-level GET, bloque
        # les POST cross-site → protège contre la plupart des CSRF). `strict` casserait
        # un éventuel retour de lien externe vers l'admin ; à passer en `strict` si
        # l'admin n'est jamais atteinte via un lien tiers (durcissement possible).
        same_site="lax",
        # TLS terminé par le reverse proxy (FR-26) ; flag Secure pilotable par config
        # (défaut sûr = True en prod ; mettre False pour dev/tests en HTTP local).
        https_only=settings.session_https_only,
        # Expiration absolue du cookie (défaut 12 h) : borne le rejeu d'une session
        # oubliée/volée. 0 → on laisse Starlette sans max_age explicite.
        max_age=settings.session_max_age_seconds or None,
    )

    # Public : health (FR-27), status, auth.
    app.include_router(health_routes.router)
    app.include_router(status_routes.router)
    app.include_router(auth_routes.router)
    # Protégés par l'auth locale (FR-24) : config (secrets), sandbox, journal, export.
    app.include_router(config_routes.router, dependencies=[Depends(require_auth)])
    app.include_router(sandbox_routes.router, dependencies=[Depends(require_auth)])
    app.include_router(decisions_routes.router)
    app.include_router(export_routes.router)
    app.include_router(insights_routes.router)
    app.include_router(referentials_routes.router)
    app.include_router(glpi_routes.router)
    app.include_router(debug_routes.router)
    app.include_router(automations_routes.router)
    app.include_router(license_routes.router)
    app.include_router(version_routes.router)
    app.include_router(privacy_routes.router)
    app.include_router(cost_routes.router)

    # Observabilité : métriques Prometheus d'infra à GET /metrics (NON authentifié,
    # scrape interne). Branché AVANT le catch-all SPA pour que /metrics ne soit pas
    # capté par le mount statique. Désactivable via settings.metrics_enabled.
    if settings.metrics_enabled:
        from .metrics import install_metrics

        install_metrics(app)

    # UI web (Phase 2) — SPA React buildée, servie en statique (catch-all en dernier).
    mount_spa(app, Path(settings.frontend_dist))

    return app


app = create_app()
