"""execution modes per entity

Revision ID: e52d59bbdccb
Revises: cb8ffef4f8f3
Create Date: 2026-05-26 17:44:04.083863
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel  # noqa: F401
from alembic import op



revision: str = 'e52d59bbdccb'
down_revision: str | None = 'cb8ffef4f8f3'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Mode d'exécution par entité (nullable → défaut global si absent).
    with op.batch_alter_table("referential_cache", schema=None) as batch_op:
        batch_op.add_column(sa.Column("mode", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("auto_min_confidence", sa.Float(), nullable=True))
    # Traçabilité de l'action appliquée dans le journal de décision.
    with op.batch_alter_table("decisions", schema=None) as batch_op:
        batch_op.add_column(sa.Column("mode", sa.String(), nullable=False, server_default=""))
        batch_op.add_column(
            sa.Column("applied", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table("decisions", schema=None) as batch_op:
        batch_op.drop_column("applied")
        batch_op.drop_column("mode")
    with op.batch_alter_table("referential_cache", schema=None) as batch_op:
        batch_op.drop_column("auto_min_confidence")
        batch_op.drop_column("mode")
