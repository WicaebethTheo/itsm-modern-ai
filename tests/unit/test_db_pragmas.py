"""PRAGMA SQLite posés à chaque connexion (réduction des « database is locked »).

Le moteur SQLite doit passer en mode WAL (lectures concurrentes aux écritures) et poser
un busy_timeout, appliqués par le listener `connect`. Non pertinent pour Postgres.
"""

from __future__ import annotations

from itsm_modern_ai.persistence import db


def test_sqlite_connection_uses_wal_and_busy_timeout(temp_db):
    with db.get_engine().connect() as conn:
        mode = conn.exec_driver_sql("PRAGMA journal_mode").scalar()
        busy = conn.exec_driver_sql("PRAGMA busy_timeout").scalar()
    assert str(mode).lower() == "wal"
    assert int(busy) == 5000
