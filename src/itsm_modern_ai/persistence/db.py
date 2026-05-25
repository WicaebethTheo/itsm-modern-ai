"""Moteur & sessions SQLModel (SQLite en pilote, Postgres-ready)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine
from sqlmodel import Session, SQLModel, create_engine

from . import tables  # noqa: F401  (enregistre les tables dans SQLModel.metadata)

_engine: Engine | None = None


def _ensure_sqlite_dir(database_url: str) -> None:
    prefix = "sqlite:///"
    if database_url.startswith(prefix):
        db_path = Path(database_url[len(prefix):])
        db_path.parent.mkdir(parents=True, exist_ok=True)


def init_engine(database_url: str) -> Engine:
    """Crée (une fois) le moteur. SQLite : check_same_thread=False pour l'async."""
    global _engine
    _ensure_sqlite_dir(database_url)
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    _engine = create_engine(database_url, connect_args=connect_args)
    return _engine


def get_engine() -> Engine:
    if _engine is None:
        raise RuntimeError("Engine non initialisé : appeler init_engine() au démarrage.")
    return _engine


def create_all() -> None:
    """Crée les tables. Alembic reste la source de vérité pour les évolutions."""
    SQLModel.metadata.create_all(get_engine())


@contextmanager
def session_scope() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session
