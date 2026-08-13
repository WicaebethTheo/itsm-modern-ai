"""processed_tickets.processed_at en timezone-aware + index

Revision ID: d2f8a9c5
Revises: c1a7e4b2
Create Date: 2026-05-29 10:00:00.000000

Cohérence avec `decisions.ts` / `llm_calls.ts` (cf. c1a7e4b2_ts_timezone_aware.py) :
`processed_at` passe `timestamp without time zone` → `timestamp with time zone` et
gagne un index (tri/recherche par date — diagnostic, futur purge éventuel).

CORRECTION D'UNE RÉVISION DÉJÀ PUBLIÉE : même défaut, même remède qu'en c1a7e4b2. La
conversion se faisait sans `USING`, donc dans le fuseau du SERVEUR : sur une base en
`Europe/Paris`, un `processed_at` à `12:00` UTC devenait `11:00` UTC. `processed_at` est
la clé d'idempotence temporelle du poller — un décalage d'une heure y déplace la fenêtre
« déjà traité ». On force donc `USING processed_at AT TIME ZONE 'UTC'` (ces valeurs sont
produites par `_utcnow()`, ce sont des instants UTC), aller ET retour.

Concernées : les bases PostgreSQL au fuseau non-UTC **pas encore** passées par cette
révision. Une base déjà migrée a subi le décalage, non rattrapable après coup.
`op.batch_alter_table` disparaît : il n'existait que pour SQLite, qui n'est plus supporté,
et il masquait la clause `USING`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d2f8a9c5"
down_revision: str | None = "c1a7e4b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "processed_tickets",
        "processed_at",
        existing_type=sa.DateTime(),
        type_=sa.DateTime(timezone=True),
        existing_nullable=False,
        # Sans ce `USING`, l'interprétation dépendrait du fuseau du serveur (cf. en-tête).
        postgresql_using="processed_at AT TIME ZONE 'UTC'",
    )
    op.create_index(
        "ix_processed_tickets_processed_at",
        "processed_tickets",
        ["processed_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_processed_tickets_processed_at", table_name="processed_tickets")
    op.alter_column(
        "processed_tickets",
        "processed_at",
        existing_type=sa.DateTime(timezone=True),
        type_=sa.DateTime(),
        existing_nullable=False,
        # Symétrique : on redescend en heure UTC, pas en heure locale du serveur.
        postgresql_using="processed_at AT TIME ZONE 'UTC'",
    )
