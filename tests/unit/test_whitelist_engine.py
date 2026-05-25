"""Whitelist (FR-7) + seuil de confiance (FR-8) — chemin critique non-négociable.

Vérifie l'ordre immuable (whitelist AVANT seuil) et le fallback unique « à trier ».
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from itsm_modern_ai.domain import engine
from itsm_modern_ai.domain.models import Decision, TriageReason


def _decision(**kw) -> Decision:
    base = dict(category=1, priority=3, technician_id=11, draft="ok", confidence=0.9)
    base.update(kw)
    return Decision(**base)


def test_accepts_valid_decision(refs):
    out = engine.evaluate(_decision(), refs, 0.7)
    assert out.accepted is True
    assert out.reason is TriageReason.ACCEPTED
    assert out.decision is not None


def test_rejects_category_out_of_whitelist(refs):
    out = engine.evaluate(_decision(category=999), refs, 0.7)
    assert out.is_a_trier
    assert out.reason is TriageReason.CATEGORY_NOT_IN_WHITELIST
    assert out.decision is None


def test_rejects_technician_out_of_whitelist(refs):
    out = engine.evaluate(_decision(technician_id=999), refs, 0.7)
    assert out.reason is TriageReason.TECHNICIAN_NOT_IN_WHITELIST


def test_rejects_priority_out_of_whitelist(refs):
    out = engine.evaluate(_decision(priority=42), refs, 0.7)
    assert out.reason is TriageReason.PRIORITY_NOT_IN_WHITELIST


def test_low_confidence_goes_a_trier(refs):
    out = engine.evaluate(_decision(confidence=0.5), refs, 0.7)
    assert out.is_a_trier
    assert out.reason is TriageReason.LOW_CONFIDENCE


def test_whitelist_checked_before_confidence(refs):
    # ID hors-liste ET confiance basse → la raison doit être la whitelist (ordre immuable).
    out = engine.evaluate(_decision(category=999, confidence=0.1), refs, 0.7)
    assert out.reason is TriageReason.CATEGORY_NOT_IN_WHITELIST


def test_threshold_boundary_inclusive(refs):
    # confidence == seuil → accepté (>=).
    out = engine.evaluate(_decision(confidence=0.7), refs, 0.7)
    assert out.accepted is True


def test_confidence_out_of_range_rejected_by_schema():
    with pytest.raises(ValidationError):
        Decision(category=1, priority=3, technician_id=11, draft="x", confidence=1.5)
