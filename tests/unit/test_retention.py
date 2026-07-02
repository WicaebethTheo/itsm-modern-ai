"""Rétention RGPD (services/retention) : purge bornée par fenêtre, sans I/O."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from itsm_modern_ai.domain.models import Decision, TriageOutcome, TriageReason
from itsm_modern_ai.persistence import db, journal
from itsm_modern_ai.persistence.tables import DecisionLog, LlmCall
from itsm_modern_ai.services import retention


def _seed_decision(session, ts: datetime) -> None:
    session.add(
        DecisionLog(ticket_id=1, ts=ts, accepted=True, reason=TriageReason.ACCEPTED.value)
    )
    session.commit()


def _seed_llm(session, ts: datetime) -> None:
    session.add(LlmCall(ticket_id=1, ts=ts))
    session.commit()


def test_purge_now_deletes_old_keeps_recent(temp_db):
    now = datetime(2026, 5, 28, 12, tzinfo=UTC)
    old = now - timedelta(days=500)  # plus vieux que la rétention décisions (365)
    recent = now - timedelta(days=10)  # à conserver
    with db.session_scope() as s:
        _seed_decision(s, old)
        _seed_decision(s, recent)
        _seed_llm(s, now - timedelta(days=200))  # plus vieux que rétention LLM (90)
        _seed_llm(s, now - timedelta(days=30))   # à conserver

    with db.session_scope() as s:
        result = retention.purge_now(s, decisions_days=365, llm_calls_days=90, now=now)

    assert result.decisions_deleted == 1
    assert result.llm_calls_deleted == 1
    assert result.cutoff_decisions == now - timedelta(days=365)
    assert result.cutoff_llm_calls == now - timedelta(days=90)
    with db.session_scope() as s:
        assert len(journal.list_decisions(s)) == 1
        assert journal.count_llm_calls(s) == 1


def test_purge_now_days_zero_keeps_all(temp_db):
    now = datetime.now(UTC)
    with db.session_scope() as s:
        _seed_decision(s, now - timedelta(days=1000))
        _seed_llm(s, now - timedelta(days=1000))

    with db.session_scope() as s:
        result = retention.purge_now(s, decisions_days=0, llm_calls_days=0, now=now)

    assert result.decisions_deleted == 0
    assert result.llm_calls_deleted == 0
    assert result.cutoff_decisions is None and result.cutoff_llm_calls is None
    with db.session_scope() as s:
        assert len(journal.list_decisions(s)) == 1
        assert journal.count_llm_calls(s) == 1


def test_purge_helpers_no_op_when_empty(temp_db):
    cutoff = datetime.now(UTC) - timedelta(days=1)
    with db.session_scope() as s:
        assert journal.purge_decisions_before(s, cutoff) == 0
        assert journal.purge_llm_calls_before(s, cutoff) == 0


def test_record_decision_then_purge_round_trip(temp_db):
    """Garantit l'intégration : journal écrit → purge supprime selon ts."""
    now = datetime(2026, 1, 1, tzinfo=UTC)
    outcome = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        did = journal.record_decision(s, 42, outcome)
        # Antidate la ligne pour qu'elle soit dans la fenêtre à purger.
        row = s.get(DecisionLog, did)
        row.ts = now - timedelta(days=400)
        s.add(row)
        s.commit()

    cutoff = now - timedelta(days=365)
    with db.session_scope() as s:
        assert journal.purge_decisions_before(s, cutoff) == 1
        assert journal.list_decisions(s) == []
