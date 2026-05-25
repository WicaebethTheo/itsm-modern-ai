"""Application FastAPI headless + lifespan (démarrage du scheduler de polling)."""

from __future__ import annotations

import logging
import secrets as _secrets
from contextlib import asynccontextmanager
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import Depends, FastAPI
from starlette.middleware.sessions import SessionMiddleware

from ..config.settings import Settings, get_settings
from ..persistence import db
from ..scheduler.poller import TriagePoller
from ..services.whitelist_cache import WhitelistCache
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    db.init_engine(settings.database_url)
    db.create_all()  # Alembic reste la source de vérité pour les évolutions
    app.state.secrets_box = make_secrets_box(settings)
    app.state.whitelist_cache = WhitelistCache()

    # Intervalle initial depuis la config runtime (modifiable à chaud via /api/config).
    from ..services.runtime_config import RuntimeConfigService

    with db.session_scope() as session:
        interval = RuntimeConfigService(session, app.state.secrets_box, settings).get_int(
            "polling_interval_seconds", settings.polling_interval_seconds
        )

    scheduler = AsyncIOScheduler()
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
    scheduler.start()
    app.state.scheduler = scheduler
    logger.info("démarré (interval=%ss)", interval)
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)


def create_app(settings: Settings | None = None) -> FastAPI:
    from .routes import auth as auth_routes
    from .routes import config as config_routes
    from .routes import debug as debug_routes
    from .routes import decisions as decisions_routes
    from .routes import export as export_routes
    from .routes import health as health_routes
    from .routes import insights as insights_routes
    from .routes import referentials as referentials_routes
    from .routes import sandbox as sandbox_routes
    from .routes import status as status_routes
    from .spa import mount_spa

    settings = settings or get_settings()
    app = FastAPI(
        title="ITSM Modern AI — moteur de triage (headless)",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = settings

    # Session signée pour l'auth locale (FR-24). Secret = master key si fournie,
    # sinon éphémère (sessions réinitialisées au redémarrage — acceptable en pilote).
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.master_key or _secrets.token_urlsafe(32),
        same_site="lax",
        https_only=False,  # TLS terminé par le reverse proxy (FR-26)
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
    app.include_router(debug_routes.router)

    # UI web (Phase 2) — SPA React buildée, servie en statique (catch-all en dernier).
    mount_spa(app, Path(settings.frontend_dist))

    return app


app = create_app()
