"""Repli de triage : cible par entité + traçabilité au Journal

Revision ID: a4c81d2e6f30
Revises: b3e5c1f27a04
Create Date: 2026-08-09

Un Ticket refusé par le garde-fou (« à trier ») pouvait recevoir un Suivi expliquant le
refus, mais restait NON ASSIGNÉ : personne ne le voyait passer. Ces colonnes portent la
cible de repli choisie par l'admin, PAR ENTITÉ (à côté du mode d'exécution, là où vit déjà
le rayon de souffle), et la trace de son application.

`decisions.fallback_applied` est NOT NULL : `server_default=sa.false()` est INDISPENSABLE,
la table contient déjà l'historique des décisions en production. Sans lui, l'ALTER TABLE
échoue sur base peuplée (défaut relevé sur `cb8ffef4f8f3`, non reproduit depuis).
Les colonnes de `referential_cache` sont nullables (None = aucun repli configuré) : pas de
défaut serveur nécessaire, et l'absence de valeur est ici une information, pas un trou.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a4c81d2e6f30"
down_revision = "b3e5c1f27a04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("referential_cache") as batch:
        batch.add_column(sa.Column("fallback_group_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("fallback_technician_id", sa.Integer(), nullable=True))
    with op.batch_alter_table("decisions") as batch:
        batch.add_column(
            sa.Column(
                "fallback_applied", sa.Boolean(), nullable=False, server_default=sa.false()
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("decisions") as batch:
        batch.drop_column("fallback_applied")
    with op.batch_alter_table("referential_cache") as batch:
        batch.drop_column("fallback_technician_id")
        batch.drop_column("fallback_group_id")
