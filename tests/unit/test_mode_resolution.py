"""Résolution du mode d'exécution par entité (réglage explicite vs défaut global)."""

from __future__ import annotations

from itsm_modern_ai.domain.modes import ExecutionMode
from itsm_modern_ai.persistence.tables import ReferentialCache
from itsm_modern_ai.services import referentials


def _seed_entities(session, *ext_ids):
    for ext_id in ext_ids:
        session.add(ReferentialCache(kind="entity", ext_id=ext_id, name=f"Entité {ext_id}"))
    session.commit()


def test_entity_without_mode_falls_back_to_global_default(session):
    _seed_entities(session, 1)
    mode, thr = referentials.mode_for_entity(
        session, 1, default_mode=ExecutionMode.SUGGESTION, default_auto_min_confidence=0.9
    )
    assert mode is ExecutionMode.SUGGESTION
    assert thr == 0.9


def test_unknown_entity_falls_back_to_global_default(session):
    mode, _ = referentials.mode_for_entity(
        session, 999, default_mode=ExecutionMode.FULL_AUTO, default_auto_min_confidence=0.8
    )
    assert mode is ExecutionMode.FULL_AUTO


def test_set_modes_overrides_per_entity(session):
    _seed_entities(session, 1, 2)
    referentials.set_modes(
        session,
        [
            {"ext_id": 1, "mode": "full_auto"},
            {"ext_id": 2, "mode": "semi_auto", "auto_min_confidence": 0.95},
        ],
    )
    m1, _ = referentials.mode_for_entity(
        session, 1, default_mode=ExecutionMode.SUGGESTION, default_auto_min_confidence=0.9
    )
    m2, thr2 = referentials.mode_for_entity(
        session, 2, default_mode=ExecutionMode.SUGGESTION, default_auto_min_confidence=0.9
    )
    assert m1 is ExecutionMode.FULL_AUTO
    assert m2 is ExecutionMode.SEMI_AUTO
    assert thr2 == 0.95  # seuil auto spécifique à l'entité


def test_set_modes_ignores_invalid_mode(session):
    _seed_entities(session, 1)
    referentials.set_modes(session, [{"ext_id": 1, "mode": "bogus"}])
    mode, _ = referentials.mode_for_entity(
        session, 1, default_mode=ExecutionMode.SUGGESTION, default_auto_min_confidence=0.9
    )
    assert mode is ExecutionMode.SUGGESTION  # mode invalide → None → défaut global
