"""Cost cap (FR-10) + journal/audit (FR-19/20/21)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from itsm_modern_ai.domain.models import Decision, TriageOutcome, TriageReason
from itsm_modern_ai.persistence import db, journal
from itsm_modern_ai.persistence.tables import LlmCall
from itsm_modern_ai.services import cost_cap


def test_cost_eur_formula():
    # 1M tokens in @2€ + 0.5M out @6€ = 2 + 3 = 5€
    assert cost_cap.cost_eur(1_000_000, 500_000, 2.0, 6.0) == 5.0


def test_spent_window_excludes_old_calls(temp_db):
    now = datetime.now(UTC)
    with db.session_scope() as s:
        s.add(LlmCall(ticket_id=1, cost_eur=3.0, ts=now))
        s.add(LlmCall(ticket_id=2, cost_eur=4.0, ts=now - timedelta(hours=25)))  # hors fenêtre
        s.commit()
    with db.session_scope() as s:
        assert cost_cap.spent_last_24h(s, now=now) == 3.0
        assert cost_cap.is_over_cap(s, 5.0, now=now) is False
        assert cost_cap.is_over_cap(s, 2.0, now=now) is True


def test_cap_zero_means_no_cap(temp_db):
    with db.session_scope() as s:
        s.add(LlmCall(ticket_id=1, cost_eur=999.0))
        s.commit()
    with db.session_scope() as s:
        assert cost_cap.is_over_cap(s, 0.0) is False


def test_journal_record_list_annotate(temp_db):
    outcome = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        did = journal.record_decision(s, 42, outcome, glpi_link="http://glpi/ticket?id=42")
    with db.session_scope() as s:
        rows = journal.list_decisions(s)
        assert rows[0].ticket_id == 42 and rows[0].glpi_link.endswith("id=42")
        updated = journal.set_annotation(s, did, "juste, bon routage")
        assert updated.annotation == "juste, bon routage"


def test_decisions_csv_export(temp_db):
    outcome = TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE)
    with db.session_scope() as s:
        journal.record_decision(s, 7, outcome)
    with db.session_scope() as s:
        csv_text = journal.decisions_csv(s)
    assert "ticket_id" in csv_text.splitlines()[0]
    assert "low_confidence" in csv_text


def test_csv_injection_neutralized(temp_db):
    """Une cellule commençant par =/+/-/@ (ou tab/CR) est préfixée d'une apostrophe."""
    outcome = TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE)
    with db.session_scope() as s:
        did = journal.record_decision(s, 7, outcome)
        journal.set_annotation(s, did, "=cmd|'/C calc'!A1")
    with db.session_scope() as s:
        csv_text = journal.decisions_csv(s)
    # Le payload de formule est neutralisé : la cellule est préfixée d'une apostrophe,
    # donc aucune cellule ne commence directement par '='.
    assert "'=cmd|" in csv_text  # préfixé apostrophe
    import csv as _csv

    rows = list(_csv.reader(csv_text.splitlines()))
    assert all(not cell.startswith(("=", "+", "-", "@")) for row in rows for cell in row)

    # Idem export des appels LLM (response_received contrôlable côté LLM).
    with db.session_scope() as s:
        journal.record_llm_call(
            s, ticket_id=1, model="m", prompt_sent="masqué",
            response_received="@SUM(1+1)", prompt_tokens=1, completion_tokens=1, cost_eur=0.0,
        )
    with db.session_scope() as s:
        llm_csv = journal.llm_calls_csv(s)
    assert "'@SUM(1+1)" in llm_csv


def test_avg_confidence_and_daily_series(temp_db):
    from itsm_modern_ai.domain.models import Decision

    def acc(conf):
        return TriageOutcome(
            accepted=True, reason=TriageReason.ACCEPTED,
            decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=conf),
        )

    with db.session_scope() as s:
        journal.record_decision(s, 1, acc(0.8))
        journal.record_decision(s, 2, acc(1.0))
        journal.record_decision(s, 3, TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE))
    with db.session_scope() as s:
        assert journal.avg_confidence(s) == 0.9  # moyenne de 0.8 et 1.0 (None ignoré)
        series = journal.daily_series(s, days=14)
        assert len(series) == 14
        today = series[-1]
        assert today["accepted"] == 2 and today["a_trier"] == 1


def test_llm_calls_csv_and_count(temp_db):
    with db.session_scope() as s:
        journal.record_llm_call(
            s, ticket_id=1, model="m", prompt_sent="masqué", response_received="{}",
            prompt_tokens=10, completion_tokens=2, cost_eur=0.01,
        )
    with db.session_scope() as s:
        assert journal.count_llm_calls(s) == 1
        assert "prompt_sent" in journal.llm_calls_csv(s)
