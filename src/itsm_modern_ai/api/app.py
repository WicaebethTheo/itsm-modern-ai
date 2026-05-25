"""Application FastAPI headless + lifespan (démarrage du scheduler de polling)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import FastAPI

from ..config.settings import Settings, get_settings
from ..persistence import db
from ..scheduler.poller import TriagePoller
from ..services.whitelist_cache import WhitelistCache
from .runtime import build_connector, make_secrets_box

logger = logging.getLogger("itsm.app")


async def _run_poll_cycle(app: FastAPI) -> None:
    """Job planifié : (re)construit le connecteur depuis la config et poll une fois."""
    settings: Settings = app.state.settings
    connector = build_connector(settings, app.state.secrets_box)
    if connector is None:
        logger.info("poll: GLPI non configuré (clé/URL à pousser via /api/config) — cycle ignoré")
        return
    poller = TriagePoller(
        connector,
        app.state.whitelist_cache,
        handler=app.state.ticket_handler,  # None en Epic 2 ; câblé en Epic 3
    )
    await poller.poll_once()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    db.init_engine(settings.database_url)
    db.create_all()  # Alembic reste la source de vérité pour les évolutions
    app.state.secrets_box = make_secrets_box(settings)
    app.state.whitelist_cache = WhitelistCache()
    app.state.ticket_handler = None

    scheduler = AsyncIOScheduler()
    if settings.polling_enabled:
        scheduler.add_job(
            _run_poll_cycle,
            trigger=IntervalTrigger(seconds=settings.polling_interval_seconds),
            args=[app],
            id="poll",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
    scheduler.start()
    app.state.scheduler = scheduler
    logger.info("démarré (polling=%s, interval=%ss)", settings.polling_enabled, settings.polling_interval_seconds)
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)


def create_app(settings: Settings | None = None) -> FastAPI:
    from .routes import config as config_routes
    from .routes import health as health_routes
    from .routes import status as status_routes

    app = FastAPI(
        title="ITSM Modern AI — moteur de triage (headless)",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = settings or get_settings()
    app.include_router(health_routes.router)
    app.include_router(status_routes.router)
    app.include_router(config_routes.router)
    return app


app = create_app()
