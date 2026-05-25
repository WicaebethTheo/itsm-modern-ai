"""Dépendances FastAPI."""

from __future__ import annotations

from collections.abc import Iterator

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


def get_config_service(request: Request) -> Iterator[RuntimeConfigService]:
    with db.session_scope() as session:
        yield RuntimeConfigService(session, request.app.state.secrets_box, request.app.state.settings)
