"""ts en timezone-aware (decisions, llm_calls)

Revision ID: c1a7e4b2
Revises: 89fd91bb3b28
Create Date: 2026-05-28 19:50:00.000000

Sur Postgres : passe `timestamp without time zone` → `timestamp with time zone`
(évite `TypeError: can't compare offset-naive and offset-aware` lors d'un purge_now).
Sur SQLite : no-op effectif (tout est TEXT), la normalisation se fait via le
`UtcDateTime` TypeDecorator côté SQLAlchemy.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1a7e4b2"
down_revision: str | None = "89fd91bb3b28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("decisions", schema=None) as batch_op:
        batch_op.alter_column(
            "ts",
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=False,
        )
    with op.batch_alter_table("llm_calls", schema=None) as batch_op:
        batch_op.alter_column(
            "ts",
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("decisions", schema=None) as batch_op:
        batch_op.alter_column(
            "ts",
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=False,
        )
    with op.batch_alter_table("llm_calls", schema=None) as batch_op:
        batch_op.alter_column(
            "ts",
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=False,
        )
