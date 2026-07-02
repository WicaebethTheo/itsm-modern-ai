"""processed_tickets.processed_at en timezone-aware + index

Revision ID: d2f8a9c5
Revises: c1a7e4b2
Create Date: 2026-05-29 10:00:00.000000

Cohérence avec `decisions.ts` / `llm_calls.ts` (cf. c1a7e4b2_ts_timezone_aware.py) :
`processed_at` passe `timestamp without time zone` → `timestamp with time zone` et
gagne un index (tri/recherche par date — diagnostic, futur purge éventuel).
Sur SQLite : no-op effectif pour le type (TEXT) ; l'index est créé.
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
    with op.batch_alter_table("processed_tickets", schema=None) as batch_op:
        batch_op.alter_column(
            "processed_at",
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=False,
        )
    op.create_index(
        "ix_processed_tickets_processed_at",
        "processed_tickets",
        ["processed_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_processed_tickets_processed_at", table_name="processed_tickets")
    with op.batch_alter_table("processed_tickets", schema=None) as batch_op:
        batch_op.alter_column(
            "processed_at",
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=False,
        )
