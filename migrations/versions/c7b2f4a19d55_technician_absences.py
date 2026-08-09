"""technician_absences — congés et remplaçants (routage FR-15)

Revision ID: c7b2f4a19d55
Revises: a4c81d2e6f30
Create Date: 2026-08-09

Table DÉDIÉE plutôt qu'une colonne sur `referential_cache` : un technicien a plusieurs
absences dans l'année, et une colonne unique obligerait à écraser la précédente ou à
sérialiser une liste dans une chaîne.

Colonnes `Date` (pas `DateTime`) : une absence est posée par un humain dans un calendrier,
bornes incluses, granularité jour. Stocker un instant aurait fait entrer le fuseau horaire
dans la BASE, alors qu'il n'a lieu d'intervenir qu'à l'ÉVALUATION (« quel jour sommes-nous
ici ? », cf. `services/absences.today_local`).

Création de table : aucun `server_default` à prévoir (rien à rétro-remplir).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "c7b2f4a19d55"
down_revision = "a4c81d2e6f30"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "technician_absences",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("technician_ext_id", sa.Integer(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("replacement_ext_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.String(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_technician_absences_technician_ext_id",
        "technician_absences",
        ["technician_ext_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_technician_absences_technician_ext_id", table_name="technician_absences")
    op.drop_table("technician_absences")
