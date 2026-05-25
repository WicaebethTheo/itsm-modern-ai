"""Dépendances FastAPI."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import Request
from sqlmodel import Session

from ..config.settings import Settings
from ..persistence import db
from ..services.runtime_config import RuntimeConfigService


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_session() -> Iterator[Session]:
    with db.session_scope() as session:
        yield session


@contextmanager
def config_service_from_request(request: Request) -> Iterator[RuntimeConfigService]:
    """Service de config dans un context manager (usage hors dépendance FastAPI)."""
    with db.session_scope() as session:
        yield RuntimeConfigService(session, request.app.state.secrets_box, request.app.state.settings)


def get_config_service(request: Request) -> Iterator[RuntimeConfigService]:
    with config_service_from_request(request) as cfg:
        yield cfg
