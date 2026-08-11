"""referential_cache.updated_at et runtime_config.updated_at en timestamptz

Revision ID: a9c17f4b3e60
Revises: e8d3a71c46b9
Create Date: 2026-08-11 09:00:00.000000

Dernier trou de l'invariant « horodatage aware UTC partout » (cf. c1a7e4b2 pour
`decisions.ts` / `llm_calls.ts`, d2f8a9c5 pour `processed_tickets.processed_at`). Ces deux
colonnes étaient déclarées `Field(default_factory=_utcnow)` SANS `sa_column`, ce qui laisse
SQLModel poser un `timestamp WITHOUT time zone` : PostgreSQL y interprète alors la valeur
écrite dans le fuseau de la SESSION, pas en UTC. Sur un serveur ou une session en
`Europe/Paris`, `updated_at` était donc décalé d'une à deux heures — silencieusement.

POURQUOI UN `USING ... AT TIME ZONE 'UTC'` EXPLICITE
----------------------------------------------------
Un simple `ALTER TABLE ... TYPE timestamptz` n'est PAS neutre : PostgreSQL interprète alors
chaque valeur existante dans le fuseau du SERVEUR (`TimeZone`). Sur une instance dont le
fuseau n'est pas UTC, la conversion décalerait toutes les lignes déjà en base — exactement
le bug qu'on vient corriger, mais figé dans les données. Or ces valeurs ont été produites
par `_utcnow()` : ce sont des instants UTC. On force donc l'interprétation avec
`USING updated_at AT TIME ZONE 'UTC'`, qui lit le `timestamp` nu COMME de l'UTC et rend le
`timestamptz` correspondant. Résultat identique quel que soit le fuseau du serveur, ce qui
rend la migration reproductible — c'est le point : une migration dont le résultat dépend
d'un réglage de l'hôte n'est pas une migration, c'est un pari.

Le `downgrade` applique la transformation INVERSE avec la même règle explicite
(`AT TIME ZONE 'UTC'` sur un `timestamptz` rend le `timestamp` nu en UTC) : l'aller-retour
`upgrade` → `downgrade` → `upgrade` restitue donc l'instant d'origine, ce que le job
`migrations` de la CI et le `--rollback` de l'installeur empruntent réellement.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a9c17f4b3e60"
down_revision: str | None = "e8d3a71c46b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (table, colonne) — les deux dernières colonnes datées restées sans fuseau.
COLONNES = (("referential_cache", "updated_at"), ("runtime_config", "updated_at"))


def upgrade() -> None:
    for table, colonne in COLONNES:
        op.alter_column(
            table,
            colonne,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=False,
            # Sans ce `USING`, l'interprétation dépendrait du fuseau du serveur (cf. en-tête).
            postgresql_using=f"{colonne} AT TIME ZONE 'UTC'",
        )


def downgrade() -> None:
    for table, colonne in COLONNES:
        op.alter_column(
            table,
            colonne,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=False,
            # Symétrique : on redescend en heure UTC, pas en heure locale du serveur.
            postgresql_using=f"{colonne} AT TIME ZONE 'UTC'",
        )
