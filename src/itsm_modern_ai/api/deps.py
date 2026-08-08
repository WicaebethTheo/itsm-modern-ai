"""Dépendances FastAPI."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import Request
from sqlmodel import Session

from ..config.settings import Settings
from ..persistence import db
from ..services.runtime_config import RuntimeConfigService
from .client_ip import client_ip


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_session() -> Iterator[Session]:
    with db.session_scope() as session:
        yield session


@contextmanager
def config_service_from_request(request: Request) -> Iterator[RuntimeConfigService]:
    """Service de config dans un context manager (usage hors dépendance FastAPI).

    L'`actor` est câblé ICI, au seul endroit où la requête HTTP est disponible : le service
    n'a pas accès au contexte web, mais toute écriture de configuration passant par une
    requête doit être imputable (journal d'audit, cf. `persistence.tables.AuditLog`).
    Hors requête (scheduler, CLI), le service garde son défaut « system ».
    """
    settings = request.app.state.settings
    actor = client_ip(
        request,
        bool(getattr(settings, "trust_proxy_headers", False)),
        trusted_hops=int(getattr(settings, "trusted_proxy_hops", 1)),
    )
    with db.session_scope() as session:
        yield RuntimeConfigService(
            session, request.app.state.secrets_box, settings, actor=actor
        )


def get_config_service(request: Request) -> Iterator[RuntimeConfigService]:
    with config_service_from_request(request) as cfg:
        yield cfg
