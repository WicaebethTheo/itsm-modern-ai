"""journal d'audit des actions d'administration (audit_log)

Revision ID: f7a1c3d90b12
Revises: d2f8a9c5
Create Date: 2026-08-08 10:00:00.000000

Ajoute la table `audit_log` : une ligne par écriture de configuration (qui, quand, quelle
clé, ancienne → nouvelle valeur), alimentée par `RuntimeConfigService.set` / `set_secret`.
Aucune valeur secrète n'y est stockée (`***`).

`ts` est timezone-aware dès la création (cohérent avec `decisions.ts` / `llm_calls.ts`,
cf. c1a7e4b2) — inutile de repasser derrière comme pour les tables historiques.
Index : `ts` (fenêtre temporelle « qu'est-ce qui a changé cette semaine ? »), `actor`
(« qu'a fait cette IP ? ») et `key` (« qui a touché la rétention ? ») — les trois questions
que pose un RSSI, chacune sans scan complet.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel  # noqa: F401  (types AutoString générés par SQLModel)
from alembic import op

revision: str = "f7a1c3d90b12"
down_revision: str | None = "d2f8a9c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("actor", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("action", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("key", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("old_value", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("new_value", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("audit_log", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_audit_log_ts"), ["ts"], unique=False)
        batch_op.create_index(batch_op.f("ix_audit_log_actor"), ["actor"], unique=False)
        batch_op.create_index(batch_op.f("ix_audit_log_action"), ["action"], unique=False)
        batch_op.create_index(batch_op.f("ix_audit_log_key"), ["key"], unique=False)


def downgrade() -> None:
    # ⚠️ Le downgrade DÉTRUIT les traces d'imputabilité : à ne jouer que sur un
    # environnement de test, jamais pour « faire de la place » en production.
    with op.batch_alter_table("audit_log", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_audit_log_key"))
        batch_op.drop_index(batch_op.f("ix_audit_log_action"))
        batch_op.drop_index(batch_op.f("ix_audit_log_actor"))
        batch_op.drop_index(batch_op.f("ix_audit_log_ts"))
    op.drop_table("audit_log")
