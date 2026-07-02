"""Dispatch d'action par mode d'exécution (suggestion / semi-auto / full-auto).

Fonction pure `resolve_action` : matrice mode × confiance. Vérifie que le Suivi
privé est toujours écrit quand on agit, et que « à trier » ne déclenche rien.
"""

from __future__ import annotations

from itsm_modern_ai.domain.models import Decision, TriageOutcome, TriageReason
from itsm_modern_ai.domain.modes import ExecutionMode, resolve_action


def _accepted(confidence: float) -> TriageOutcome:
    d = Decision(category=1, priority=3, technician_id=11, draft="ok", confidence=confidence)
    return TriageOutcome(accepted=True, reason=TriageReason.ACCEPTED, decision=d)


def _a_trier() -> TriageOutcome:
    return TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE, decision=None)


def test_suggestion_never_applies_but_writes_followup():
    a = resolve_action(_accepted(0.99), ExecutionMode.SUGGESTION, auto_min_confidence=0.9)
    assert a.apply is False
    assert a.write_followup is True
    assert a.mode is ExecutionMode.SUGGESTION


def test_full_auto_applies_when_accepted():
    a = resolve_action(_accepted(0.71), ExecutionMode.FULL_AUTO, auto_min_confidence=0.9)
    assert a.apply is True
    assert a.write_followup is True  # Suivi toujours écrit (audit)


def test_semi_auto_applies_above_strict_threshold():
    a = resolve_action(_accepted(0.92), ExecutionMode.SEMI_AUTO, auto_min_confidence=0.9)
    assert a.apply is True
    assert a.write_followup is True


def test_semi_auto_falls_back_to_suggestion_below_strict_threshold():
    a = resolve_action(_accepted(0.85), ExecutionMode.SEMI_AUTO, auto_min_confidence=0.9)
    assert a.apply is False  # sous le 2e seuil → comportement suggestion
    assert a.write_followup is True


def test_semi_auto_threshold_is_inclusive():
    a = resolve_action(_accepted(0.90), ExecutionMode.SEMI_AUTO, auto_min_confidence=0.9)
    assert a.apply is True  # >= strict


def test_a_trier_triggers_no_action_in_any_mode():
    for mode in ExecutionMode:
        a = resolve_action(_a_trier(), mode, auto_min_confidence=0.9)
        assert a.apply is False
        assert a.write_followup is False
