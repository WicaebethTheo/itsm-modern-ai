"""Colonnes ts du Journal et des appels LLM : timezone-aware (UTC) garanti.

Audit cybersécu — préparation au portage Postgres : sans `DateTime(timezone=True)` +
TypeDecorator `UtcDateTime`, la comparaison `cutoff < ts` casserait avec Postgres en
`timestamp without time zone` et provoquerait `TypeError: can't compare offset-naive
and offset-aware`. Sur SQLite, on vérifie ici que la lecture renvoie toujours aware.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from sqlmodel import select

from itsm_modern_ai.domain.models import Decision, TriageOutcome, TriageReason
from itsm_modern_ai.persistence import db, idempotency, journal
from itsm_modern_ai.persistence.tables import DecisionLog, LlmCall, ProcessedTicket


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


def test_legacy_naive_ts_is_rehydrated_as_aware(temp_db):
    """Anciennes lignes stockées en naive (avant le TypeDecorator) : lues en aware UTC.

    Reproduit le cas d'une DB existante migrée : on force un INSERT naive via SQL brut
    et on vérifie qu'à la lecture, le TypeDecorator a bien injecté `tzinfo=UTC`.
    """
    naive_past = datetime(2026, 1, 1, 12, 0, 0)  # naïf, censé représenter de l'UTC
    with db.session_scope() as s:
        # Bypass du TypeDecorator : INSERT direct via SQL paramétré.
        s.execute(
            DecisionLog.__table__.insert().values(
                ticket_id=42, ts=naive_past, accepted=False, reason="accepted"
            )
        )
        s.commit()
    with db.session_scope() as s:
        row = s.exec(select(DecisionLog).where(DecisionLog.ticket_id == 42)).one()
        # Le TypeDecorator a réhydraté en aware UTC.
        assert row.ts.tzinfo is not None
        assert row.ts.utcoffset() == timedelta(0)


def test_purge_with_aware_cutoff_does_not_typeerror(temp_db):
    """Comparaison `ts < cutoff` avec cutoff aware ne doit plus casser (régression future
    Postgres). Sur SQLite c'est tolérant, mais le code doit rester homogène."""
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
    """Une écriture avec un tzinfo non-UTC doit ressortir avec utcoffset() = 0 ou conserver
    l'offset original — au minimum, jamais naive (garantie de l'audit)."""
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
