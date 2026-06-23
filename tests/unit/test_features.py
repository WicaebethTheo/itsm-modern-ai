"""Features Supporter intégrées : enregistrement dans le registre + comportement unitaire.

Le code de ces features est LIVRÉ dans l'image (package `itsm_modern_ai.features`) ; il
reste verrouillé tant qu'une licence Supporter valide ne l'autorise pas (testé ailleurs).
On vérifie ici l'enregistrement et la logique pure de chaque feature.
"""

from __future__ import annotations

from datetime import datetime

from itsm_modern_ai.domain.licensing import (
    FEATURE_MULTI_ENTITY,
    FEATURE_PII_ADVANCED,
    FEATURE_SCHEDULED_EXPORTS,
)
from itsm_modern_ai.features import register as register_features
from itsm_modern_ai.features.multi_entity import EntityPolicy, MultiEntityResolver
from itsm_modern_ai.features.pii_advanced import AdvancedPiiMasker
from itsm_modern_ai.features.scheduled_exports import ExportSchedule
from itsm_modern_ai.plugins import PluginRegistry


def test_register_installs_all_three_features():
    reg = PluginRegistry()
    register_features(reg)
    assert reg.installed_features() == {
        FEATURE_PII_ADVANCED,
        FEATURE_MULTI_ENTITY,
        FEATURE_SCHEDULED_EXPORTS,
    }


def test_pii_advanced_masks_nir_and_siret():
    m = AdvancedPiiMasker()
    out = m.mask("NIR 1 85 12 75 116 001 42 SIRET 732 829 320 00074")
    assert "[NIR]" in out and "[SIRET]" in out
    assert "85 12 75" not in out


def test_pii_advanced_custom_patterns():
    m = AdvancedPiiMasker.from_rules([{"pattern": r"MATR-\d+", "placeholder": "[MATR]"}])
    assert m.mask("dossier MATR-12345 urgent") == "dossier [MATR] urgent"


def test_pii_advanced_from_rules_skips_invalid_regex(caplog):
    """Une regex invalide est ignorée (warning), les règles valides restent actives."""
    import logging

    with caplog.at_level(logging.WARNING):
        m = AdvancedPiiMasker.from_rules(
            [
                {"pattern": r"TICKET-(\d{5}", "placeholder": "[T]"},  # parenthèse non fermée
                {"pattern": r"MATR-\d+", "placeholder": "[MATR]"},
            ]
        )
    assert len(m.custom_patterns) == 1
    assert m.mask("MATR-7 / TICKET-12345") == "[MATR] / TICKET-12345"
    assert "regex invalide" in caplog.text


def test_pii_advanced_from_rules_skips_oversized_pattern(caplog):
    """Un pattern au-delà de la taille max est ignoré (warning) sans être compilé."""
    import logging

    with caplog.at_level(logging.WARNING):
        m = AdvancedPiiMasker.from_rules([{"pattern": "a" * 513, "placeholder": "[X]"}])
    assert m.custom_patterns == []
    assert "trop long" in caplog.text


def test_multi_entity_inherits_from_parent():
    policies = {
        1: EntityPolicy(entity_id=1, parent_id=None, execution_mode="full_auto"),
        2: EntityPolicy(entity_id=2, parent_id=1),  # hérite de 1
        3: EntityPolicy(entity_id=3, parent_id=1, execution_mode="suggestion"),
    }
    r = MultiEntityResolver(policies)
    assert r.effective_mode(2, global_default="semi_auto") == "full_auto"  # hérité
    assert r.effective_mode(3, global_default="semi_auto") == "suggestion"  # override
    assert r.effective_mode(99, global_default="semi_auto") == "semi_auto"  # inconnu → défaut


def test_scheduled_export_next_run_is_in_future():
    sched = ExportSchedule(every_days=7, hour_utc=4)
    now = datetime(2026, 5, 31, 10, 0, 0)
    nxt = sched.next_run_after(now)
    assert nxt > now
