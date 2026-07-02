"""Moteur & sessions SQLModel (SQLite en pilote ; PostgreSQL en option — Beta)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, event
from sqlmodel import Session, SQLModel, create_engine

from . import tables  # noqa: F401  (enregistre les tables dans SQLModel.metadata)

_engine: Engine | None = None


def _ensure_sqlite_dir(database_url: str) -> None:
    prefix = "sqlite:///"
    if database_url.startswith(prefix):
        db_path = Path(database_url[len(prefix):])
        db_path.parent.mkdir(parents=True, exist_ok=True)


def _apply_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
    """PRAGMA appliqués à CHAQUE connexion SQLite (uniquement).

    - `journal_mode=WAL` : les lectures ne bloquent plus les écritures (et inversement),
      ce qui réduit fortement les « database is locked » quand le poller écrit pendant qu'une
      requête UI lit.
    - `busy_timeout=5000` : sur conflit d'écrou, SQLite ré-essaie jusqu'à 5 s avant d'échouer
      au lieu de lever « database is locked » immédiatement.
    """
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
    finally:
        cursor.close()


def init_engine(
    database_url: str,
    *,
    pool_size: int = 5,
    max_overflow: int = 10,
    pool_pre_ping: bool = True,
) -> Engine:
    """Crée (une fois) le moteur.

    - **SQLite** (défaut pilote) : `check_same_thread=False` pour l'usage async, pas de pool
      réseau (les options `pool_*` sont ignorées).
    - **PostgreSQL** (Beta) : pool de connexions (`pool_pre_ping` anti-coupure + `pool_size`
      / `max_overflow`) — adapté au multi-utilisateurs / à la prod.
    """
    global _engine
    _ensure_sqlite_dir(database_url)
    if database_url.startswith("sqlite"):
        _engine = create_engine(database_url, connect_args={"check_same_thread": False})
        # PRAGMA WAL + busy_timeout posés à chaque nouvelle connexion SQLite (pas Postgres) :
        # réduit les « database is locked » sous concurrence poller/UI.
        event.listen(_engine, "connect", _apply_sqlite_pragmas)
    else:
        _engine = create_engine(
            database_url,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_pre_ping=pool_pre_ping,
        )
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
