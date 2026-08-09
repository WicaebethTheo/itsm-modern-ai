"""processed_tickets.claimed_at — referme la fenêtre de doublon du poller

Revision ID: e8d3a71c46b9
Revises: c7b2f4a19d55
Create Date: 2026-08-09

Le poller appelait le handler PUIS posait le marqueur « traité » : un arrêt brutal entre les
deux (OOM, reboot, kill) laissait l'écriture GLPI faite sans trace locale, et le cycle suivant
rejouait le Ticket — en `full_auto`, une SECONDE réponse publique au demandeur.

Cette colonne porte la réservation posée AVANT le handler et effacée après. Non-NULL =
traitement interrompu en vol : le Ticket n'est pas rejoué (fail-closed) et l'interruption est
signalée.

Nullable, donc AUCUN `server_default` nécessaire : l'absence de valeur est l'état nominal, et
les lignes déjà en base (Tickets traités par les versions antérieures) sont correctement
interprétées comme « aucune réservation en cours ».
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e8d3a71c46b9"
down_revision = "c7b2f4a19d55"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("processed_tickets") as batch:
        batch.add_column(sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("processed_tickets") as batch:
        batch.drop_column("claimed_at")
