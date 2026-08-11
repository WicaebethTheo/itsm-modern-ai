"""ts en timezone-aware (decisions, llm_calls)

Revision ID: c1a7e4b2
Revises: 89fd91bb3b28
Create Date: 2026-05-28 19:50:00.000000

Passe `timestamp without time zone` → `timestamp with time zone` (évite
`TypeError: can't compare offset-naive and offset-aware` lors d'un purge_now).

CORRECTION D'UNE RÉVISION DÉJÀ PUBLIÉE — POURQUOI ON Y TOUCHE
-------------------------------------------------------------
Cette révision faisait son `ALTER TABLE ... TYPE timestamptz` SANS `USING`. Or la
conversion n'est alors PAS neutre : PostgreSQL interprète chaque valeur existante dans le
fuseau du SERVEUR (`TimeZone`). Mesuré sur une base en `Europe/Paris` : un `ts` écrit à
`12:00` UTC ressortait à `11:00` UTC — une heure perdue, y compris sur le journal d'audit
RGPD, et sans le moindre message. Ces valeurs viennent toutes de `_utcnow()` : ce sont des
instants UTC, on force donc l'interprétation avec `USING ts AT TIME ZONE 'UTC'`. Le
résultat devient identique quel que soit le fuseau de l'hôte — c'est le point : une
migration dont le résultat dépend d'un réglage de la machine n'est pas une migration,
c'est un pari (le même que la révision a9c17f4b3e60 décrit et refuse).

QUI EST CONCERNÉ. Uniquement une base PostgreSQL dont le fuseau serveur n'est pas UTC et
qui n'est **pas encore** passée par cette révision (installation neuve, ou instance restée
en deçà). Une base déjà migrée a subi le décalage : il n'est pas rattrapable ici — on ne
sait plus, après coup, distinguer une valeur décalée d'une valeur correcte. Rejouer la
révision sur une telle base ne referait rien (la colonne est déjà `timestamptz`).

Le `downgrade` applique la transformation INVERSE avec la même règle explicite
(`AT TIME ZONE 'UTC'` sur un `timestamptz` rend le `timestamp` nu en UTC) : l'aller-retour
`upgrade` → `downgrade` → `upgrade` restitue donc l'instant d'origine, ce que le job
`migrations` de la CI et le `--rollback` de l'installeur empruntent réellement.

`op.batch_alter_table` a disparu au passage : il n'existait que pour SQLite (recréation de
table), qui n'est plus une base supportée, et il masquait la clause `USING`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1a7e4b2"
down_revision: str | None = "89fd91bb3b28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("decisions", "llm_calls")


def upgrade() -> None:
    for table in TABLES:
        op.alter_column(
            table,
            "ts",
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=False,
            # Sans ce `USING`, l'interprétation dépendrait du fuseau du serveur (cf. en-tête).
            postgresql_using="ts AT TIME ZONE 'UTC'",
        )


def downgrade() -> None:
    for table in TABLES:
        op.alter_column(
            table,
            "ts",
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=False,
            # Symétrique : on redescend en heure UTC, pas en heure locale du serveur.
            postgresql_using="ts AT TIME ZONE 'UTC'",
        )
