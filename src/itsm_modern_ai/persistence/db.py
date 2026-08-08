"""Moteur & sessions SQLModel (SQLite en pilote ; PostgreSQL en option — Beta)."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, event, text
from sqlmodel import Session, SQLModel, create_engine

from . import tables  # noqa: F401  (enregistre les tables dans SQLModel.metadata)

_engine: Engine | None = None

# Existe-t-il DÉJÀ au moins un secret chiffré en base ? (cf. `has_encrypted_secrets`)
_HAS_SECRETS_SQL = "SELECT 1 FROM runtime_config WHERE is_secret AND value <> '' LIMIT 1"


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


def has_encrypted_secrets(sqlite_fallback: str | Path | None = None) -> bool | None:
    """`runtime_config` contient-elle DÉJÀ au moins un secret chiffré ?

    Sert de garde-fou au démarrage : si la réponse est **oui** et que `data/master.key`
    a disparu, générer une nouvelle clé rendrait tous ces secrets illisibles en silence
    (hash admin, tokens GLPI, clé LLM) — cf. `adapters/secrets/encrypted.py`.

    Trois réponses possibles, volontairement :
    - `True`  : des secrets chiffrés existent → il y a bien quelque chose à perdre ;
    - `False` : base lisible et sans aucun secret → premier démarrage légitime ;
    - `None`  : **indéterminé** (moteur non initialisé et aucune base SQLite lisible à
      l'emplacement de repli, table `runtime_config` pas encore créée, base illisible).
      L'appelant ne doit JAMAIS traiter `None` comme un échec : on ne bloque pas un
      démarrage sur une question qu'on n'a pas pu poser.

    `sqlite_fallback` permet de répondre AVANT `init_engine()` (l'app construit sa boîte
    à secrets pour dériver le secret de session avant l'ouverture du moteur) : on lit
    alors directement le fichier SQLite, en lecture seule, sans le créer ni le modifier.
    """
    if _engine is not None:
        try:
            with _engine.connect() as conn:
                return conn.execute(text(_HAS_SECRETS_SQL)).first() is not None
        except Exception:  # table absente, base non migrée, backend injoignable…
            return None

    if sqlite_fallback is None:
        return None
    path = Path(sqlite_fallback)
    if not path.is_file():
        return None
    # `mode=ro` d'abord : aucune création de fichier, aucune écriture. Repli en
    # lecture/écriture car une base WAL ouverte en `ro` échoue quand le `-shm` doit être
    # (re)créé ; le fichier existe déjà, cette ouverture n'en crée donc aucun. `immutable`
    # n'est PAS utilisé (le moteur peut écrire en parallèle) : un WAL non checkpointé
    # reste ainsi pris en compte.
    for dsn, uri in ((f"file:{path}?mode=ro", True), (str(path), False)):
        try:
            conn = sqlite3.connect(dsn, uri=uri, timeout=5)
        except sqlite3.Error:
            continue
        try:
            return conn.execute(_HAS_SECRETS_SQL).fetchone() is not None
        except sqlite3.Error:
            continue
        finally:
            conn.close()
    return None
