"""Colonnes horodatées : timezone-aware (UTC) garanti, sur TOUTE la persistance.

Audit cybersécu : sans `DateTime(timezone=True)` + le TypeDecorator `UtcDateTime`, la
comparaison `cutoff < ts` casse avec `TypeError: can't compare offset-naive and
offset-aware` (purge RGPD, fenêtres du dashboard).

Depuis le passage à PostgreSQL exclusif, la garantie est vérifiée LÀ OÙ ELLE VIT — le type
réel de la colonne (`timestamptz`) et l'interprétation d'une écriture naïve par le serveur
— et non plus seulement à la relecture, qui passerait même sur un `timestamp` sans fuseau
(`process_result_value` réhydrate en UTC tout `datetime` naïf, et masquerait le décalage).
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import DateTime, create_engine, text
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select

from itsm_modern_ai.domain.models import Decision, TriageOutcome, TriageReason
from itsm_modern_ai.persistence import db, idempotency, journal
from itsm_modern_ai.persistence.tables import DecisionLog, LlmCall, ProcessedTicket, UtcDateTime

RACINE = Path(__file__).resolve().parents[2]


def _colonnes_horodatees() -> set[tuple[str, str]]:
    """Inventaire DÉRIVÉ des métadonnées de toute colonne portant un INSTANT.

    `UtcDateTime` est un TypeDecorator : il n'HÉRITE pas de son `impl`, et un balayage écrit
    sur `isinstance(colonne.type, DateTime)` raterait donc les colonnes DÉCORÉES — c'est-à-dire
    l'essentiel du modèle. On déballe le décorateur avant de tester, ce qui met colonnes
    décorées et colonnes nues sur le même pied : les secondes sont exactement celles qu'on
    cherche à débusquer. Les colonnes `Date` (`technician_absences`) restent dehors à
    dessein : une absence est posée au JOUR, sans instant ni fuseau.
    """
    return {
        (table.name, colonne.name)
        for table in SQLModel.metadata.tables.values()
        for colonne in table.columns
        if isinstance(getattr(colonne.type, "impl", colonne.type), DateTime)
    }


def test_decision_log_ts_is_aware_on_read(temp_db):
    outcome = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        journal.record_decision(s, 1, outcome)
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
        assert row.ts.tzinfo is not None, "ts doit être timezone-aware"
        assert row.ts.utcoffset() == timedelta(0), "ts doit être UTC"


def test_llm_call_ts_is_aware_on_read(temp_db):
    with db.session_scope() as s:
        journal.record_llm_call(
            s, ticket_id=1, model="m", prompt_sent="masqué", response_received="{}",
            prompt_tokens=10, completion_tokens=2, cost_eur=0.01,
        )
    with db.session_scope() as s:
        call = s.exec(select(LlmCall)).first()
        assert call.ts.tzinfo is not None
        assert call.ts.utcoffset() == timedelta(0)


def test_toute_colonne_horodatee_est_un_timestamptz_en_base(temp_db):
    """La garantie doit tenir dans le SCHÉMA, pas seulement dans le TypeDecorator.

    Le test décisif du portage : `UtcDateTime` déclare `DateTime(timezone=True)`, mais rien
    ne le vérifiait côté serveur. Sur une colonne `timestamp` SANS fuseau, tous les autres
    tests de ce module passeraient quand même (la relecture réhydrate en UTC) alors que
    PostgreSQL aurait silencieusement converti l'instant dans le fuseau de la session.

    ⚠️ L'inventaire part de TOUTE colonne `DateTime` du modèle, et surtout PAS des seules
    colonnes déjà typées `UtcDateTime` : c'est exactement par là que le trou est passé.
    `referential_cache.updated_at` et `runtime_config.updated_at` étaient déclarées
    `Field(default_factory=_utcnow)` sans `sa_column` — SQLModel posait donc un `DateTime`
    nu, invisible pour un test qui ne regarde que les `UtcDateTime`, et la colonne restait
    `timestamp without time zone` sans que rien ne proteste. Une exception tacite dans un
    test de garde-fou ne garde plus rien. Les colonnes `Date` (`technician_absences`) sont
    hors sujet à dessein : une absence est posée au JOUR, sans instant ni fuseau.
    """
    attendues = _colonnes_horodatees()
    # Garde-fou de l'inventaire : si ce balayage cessait de voir les colonnes, il passerait
    # au vert sur un ensemble VIDE. On épingle donc les quatre tables qui en portent une.
    assert {
        ("decisions", "ts"),
        ("llm_calls", "ts"),
        ("referential_cache", "updated_at"),
        ("runtime_config", "updated_at"),
    } <= attendues

    with db.session_scope() as s:
        reels = {
            (table, colonne): type_sql
            for table, colonne, type_sql in s.execute(
                text(
                    "SELECT table_name, column_name, data_type FROM information_schema.columns "
                    "WHERE table_schema = current_schema()"
                )
            ).all()
        }
    manquantes = attendues - set(reels)
    assert not manquantes, f"colonnes absentes du schéma créé : {manquantes}"
    naives = {cle for cle in attendues if reels[cle] != "timestamp with time zone"}
    assert not naives, f"colonnes sans fuseau en base : {naives}"
    # Le type SQLAlchemy doit l'être aussi : une colonne `DateTime(timezone=True)` posée à la
    # main serait correcte en base mais perdrait le filet d'écriture de `UtcDateTime`.
    types = {
        (table.name, colonne.name): colonne.type
        for table in SQLModel.metadata.tables.values()
        for colonne in table.columns
    }
    sans_decorateur = {cle for cle in attendues if not isinstance(types[cle], UtcDateTime)}
    assert not sans_decorateur, f"colonnes datées hors de `UtcDateTime` : {sans_decorateur}"


def test_un_datetime_naif_ecrit_est_horodate_en_utc_pas_dans_le_fuseau_de_la_session(temp_db):
    """Écriture naïve (un `datetime.now()` oublié) : elle doit être lue comme de l'UTC.

    C'est l'unique raison de garder `process_bind_param`. Sans lui, PostgreSQL interpréterait
    la valeur dans le fuseau de la SESSION — décalé ici à dessein — et l'instant enregistré
    serait faux d'une ou deux heures, avec un journal d'audit qui ment sur l'heure des faits.
    """
    naif = datetime(2026, 1, 1, 12, 0, 0)  # naïf, censé représenter de l'UTC
    with db.session_scope() as s:
        s.connection().exec_driver_sql("SET TIME ZONE 'Europe/Paris'")
        s.execute(
            DecisionLog.__table__.insert().values(
                ticket_id=42, ts=naif, accepted=False, reason="accepted"
            )
        )
        s.commit()
    with db.session_scope() as s:  # connexion neuve : fuseau de session par défaut
        row = s.exec(select(DecisionLog).where(DecisionLog.ticket_id == 42)).one()
        assert row.ts.tzinfo is not None
        assert row.ts == datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


def test_purge_with_aware_cutoff_does_not_typeerror(temp_db):
    """Comparaison `ts < cutoff` avec un cutoff aware : la purge RGPD ne doit pas casser.

    C'est le chemin qui exigeait `timestamptz` — sur une colonne sans fuseau, PostgreSQL
    refuse la comparaison. Le test le joue de bout en bout : écriture, antidatage, purge."""
    now = datetime.now(UTC)
    outcome = TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE)
    with db.session_scope() as s:
        journal.record_decision(s, 7, outcome)
        # Antidate via UPDATE pour passer dans la fenêtre purgée.
        rows = s.exec(select(DecisionLog)).all()
        for r in rows:
            r.ts = now - timedelta(days=400)
            s.add(r)
        s.commit()
    with db.session_scope() as s:
        deleted = journal.purge_decisions_before(s, now - timedelta(days=365))
    assert deleted == 1


def test_record_decision_with_offset_other_than_utc_is_normalized(temp_db):
    """Une écriture avec un tzinfo non-UTC désigne le MÊME INSTANT à la relecture.

    « Jamais naïf » ne suffisait pas comme garantie : sur `timestamptz` c'est vrai par
    construction, donc l'assertion passait quoi qu'il arrive. Ce qui compte est que
    14:00+02:00 relu vaille bien 12:00 UTC — un décalage d'offset falsifierait la
    chronologie du Journal d'audit.
    """
    # On insère avec un tz +02:00.
    paris = timezone(timedelta(hours=2))
    with db.session_scope() as s:
        s.execute(
            DecisionLog.__table__.insert().values(
                ticket_id=99,
                ts=datetime(2026, 5, 28, 14, 0, 0, tzinfo=paris),
                accepted=False,
                reason="accepted",
            )
        )
        s.commit()
    with db.session_scope() as s:
        row = s.exec(select(DecisionLog).where(DecisionLog.ticket_id == 99)).one()
        assert row.ts.tzinfo is not None
        assert row.ts == datetime(2026, 5, 28, 12, 0, tzinfo=UTC)


def _alembic(revision: str, url: str, *, fuseau: str) -> subprocess.CompletedProcess[str]:
    """`alembic upgrade <revision>` sur l'URL donnée, dans un fuseau de session imposé.

    `PGTZ` est lu par libpq à l'ouverture de la connexion : c'est le levier qui reproduit
    l'instance d'un exploitant dont le serveur (ou la session) n'est pas en UTC — et le seul
    endroit où le défaut se voit, puisqu'en UTC la conversion sans `USING` est l'identité.
    """
    resultat = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", revision],
        cwd=RACINE,
        env={**os.environ, "DATABASE_URL": url, "PGTZ": fuseau},
        capture_output=True,
        text=True,
    )
    assert resultat.returncode == 0, f"alembic upgrade {revision} :\n{resultat.stderr}"
    return resultat


def test_les_migrations_timestamptz_ne_decalent_pas_les_horodatages(db_url):
    """Le passage `timestamp` → `timestamptz` doit préserver l'INSTANT, hors UTC aussi.

    Défaut mesuré (c1a7e4b2 et d2f8a9c5, révisions déjà publiées) : un `alter_column` vers
    `timestamptz` SANS `postgresql_using` laisse PostgreSQL interpréter chaque valeur dans le
    fuseau du serveur. Sur une base en `Europe/Paris`, `12:00` UTC devenait `11:00` UTC —
    une heure perdue, en silence, y compris sur le journal d'audit RGPD.

    On rejoue donc le chemin RÉEL de l'exploitant : base à la révision d'avant, données
    écrites par l'ancien code (des `timestamp` nus qui représentent de l'UTC), puis migration
    dans une session non-UTC. Le test échoue sur le code d'avant, où l'assertion tombe
    exactement sur `11:00`.
    """
    depart = datetime(2026, 1, 1, 12, 0, 0)  # écrit par `_utcnow()` : c'est de l'UTC

    # Révision d'AVANT la première conversion : les colonnes y sont encore sans fuseau.
    _alembic("89fd91bb3b28", db_url, fuseau="Europe/Paris")
    moteur = create_engine(db_url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        with moteur.connect() as conn:
            assert conn.execute(
                text(
                    "SELECT data_type FROM information_schema.columns "
                    "WHERE table_schema = current_schema() AND table_name = 'decisions' "
                    "AND column_name = 'ts'"
                )
            ).scalar_one() == "timestamp without time zone"
            conn.execute(
                text(
                    "INSERT INTO decisions"
                    " (ticket_id, ts, subject, accepted, reason, glpi_link, annotation)"
                    " VALUES (1, :ts, 'sujet', false, 'accepted', '', '')"
                ),
                {"ts": depart},
            )
            conn.execute(
                text(
                    "INSERT INTO processed_tickets"
                    " (ticket_id, state_fingerprint, processed_at, followup_written)"
                    " VALUES (1, 'fp', :ts, false)"
                ),
                {"ts": depart},
            )

        # … puis les deux révisions incriminées, dans un fuseau qui n'est pas l'UTC.
        _alembic("d2f8a9c5", db_url, fuseau="Europe/Paris")

        with moteur.connect() as conn:
            lus = {
                "decisions.ts": conn.execute(
                    text("SELECT ts AT TIME ZONE 'UTC' FROM decisions")
                ).scalar_one(),
                "processed_tickets.processed_at": conn.execute(
                    text("SELECT processed_at AT TIME ZONE 'UTC' FROM processed_tickets")
                ).scalar_one(),
            }
    finally:
        moteur.dispose()

    decales = {nom: valeur for nom, valeur in lus.items() if valeur != depart}
    assert not decales, (
        "la migration a DÉPLACÉ des instants (conversion faite dans le fuseau du serveur, "
        f"`postgresql_using` manquant) : {decales} au lieu de {depart}"
    )


def test_processed_ticket_processed_at_is_aware_on_read(temp_db):
    """Idempotence du polling (FR-2) : `processed_at` doit ressortir aware UTC
    (cohérence avec `decisions.ts` / `llm_calls.ts`, audit cybersécu)."""
    with db.session_scope() as s:
        idempotency.mark_processed(s, ticket_id=1, state_fingerprint="fp")
    with db.session_scope() as s:
        row = s.get(ProcessedTicket, 1)
        assert row is not None
        assert row.processed_at.tzinfo is not None
        assert row.processed_at.utcoffset() == timedelta(0)
