"""decision subject (ticket title)

Revision ID: 89fd91bb3b28
Revises: e52d59bbdccb
Create Date: 2026-05-26 18:31:24.573472
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel  # noqa: F401
from alembic import op



revision: str = '89fd91bb3b28'
down_revision: str | None = 'e52d59bbdccb'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("decisions", schema=None) as batch_op:
        batch_op.add_column(sa.Column("subject", sa.String(), nullable=False, server_default=""))


def downgrade() -> None:
    with op.batch_alter_table("decisions", schema=None) as batch_op:
        batch_op.drop_column("subject")
