"""referential_cache.skill_tags — domaines de compétence cochés (routage FR-15)

Revision ID: b3e5c1f27a04
Revises: f7a1c3d90b12
Create Date: 2026-08-08

Pourquoi cette colonne : à l'installation, tant que l'admin n'a pas rédigé de fiche, le
LLM ne reçoit AUCUNE description des techniciens éligibles et route sur un patronyme —
d'où des propositions à confiance basse, rejetées par le seuil. Des domaines cochables
donnent un socle exploitable en quelques clics, sans rédiger une ligne.

`server_default=""` est INDISPENSABLE : la colonne est NOT NULL et la table contient déjà
des lignes en production (le périmètre sélectionné par l'admin). Sans défaut serveur,
l'`ALTER TABLE` échoue sur base peuplée — sur SQLite comme sur PostgreSQL, `batch_alter_table`
n'y change rien pour un simple `add_column`. C'est exactement le défaut relevé sur la
révision `cb8ffef4f8f3`, qu'on ne reproduit pas ici.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b3e5c1f27a04"
down_revision = "f7a1c3d90b12"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("referential_cache") as batch:
        batch.add_column(
            sa.Column("skill_tags", sa.String(), nullable=False, server_default="")
        )


def downgrade() -> None:
    with op.batch_alter_table("referential_cache") as batch:
        batch.drop_column("skill_tags")
