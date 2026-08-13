"""Environnement Alembic — métadonnées SQLModel, URL via pydantic-settings."""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlmodel import SQLModel

from itsm_modern_ai.config.settings import get_settings
from itsm_modern_ai.persistence import tables  # noqa: F401  (peuple SQLModel.metadata)

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ⚠️ L'URL ne passe PAS par `config.set_main_option()` / `alembic.ini`, et c'est délibéré :
# ces deux-là transitent par `configparser`, qui INTERPRÈTE les `%`. Or `.env.example`
# recommande justement d'encoder `@ : / ? #` dans le mot de passe (`p%40ss`) — configparser
# y voit alors une interpolation et lève `ValueError: invalid interpolation syntax`. Le
# conteneur mourait donc AU DÉMARRAGE, avant la moindre migration, sur un mot de passe
# pourtant conforme à la documentation. On injecte l'URL directement dans les objets
# SQLAlchemy : plus aucun `%` n'est réinterprété au passage.
DATABASE_URL = get_settings().database_url
target_metadata = SQLModel.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # Les autres réglages `sqlalchemy.*` d'`alembic.ini` restent honorés ; seule l'URL est
    # posée après coup, hors de portée de l'interpolation (cf. commentaire en tête).
    section = dict(config.get_section(config.config_ini_section, {}))
    section["sqlalchemy.url"] = DATABASE_URL
    connectable = engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
