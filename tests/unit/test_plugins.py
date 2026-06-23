"""Loader à plugins (entry points) — registre des features Supporter installées."""

from __future__ import annotations

from itsm_modern_ai.domain.licensing import (
    FEATURE_MULTI_ENTITY,
    FEATURE_PII_ADVANCED,
    FEATURE_SCHEDULED_EXPORTS,
)
from itsm_modern_ai.plugins import PluginRegistry, build_registry, load_plugins


def test_registry_records_installed_features():
    reg = PluginRegistry()
    assert reg.installed_features() == frozenset()
    reg.register_feature("multi_entity", object())
    assert "multi_entity" in reg.installed_features()
    assert reg.provider("multi_entity") is not None
    assert reg.provider("absent") is None


def test_load_plugins_invokes_register_callables(monkeypatch):
    calls = []

    class _EP:
        name = "fake"

        def load(self):
            def register(registry: PluginRegistry) -> None:
                calls.append("loaded")
                registry.register_feature("scheduled_exports", object())

            return register

    monkeypatch.setattr("itsm_modern_ai.plugins.entry_points", lambda group: [_EP()])
    reg = load_plugins(PluginRegistry())
    assert calls == ["loaded"]
    assert "scheduled_exports" in reg.installed_features()


def test_faulty_plugin_is_ignored(monkeypatch):
    class _BadEP:
        name = "bad"

        def load(self):
            raise RuntimeError("boom")

    monkeypatch.setattr("itsm_modern_ai.plugins.entry_points", lambda group: [_BadEP()])
    # Ne lève pas : le plugin défaillant est journalisé et ignoré.
    reg = load_plugins(PluginRegistry())
    assert reg.installed_features() == frozenset()


def test_builtin_supporter_features_are_installed():
    # Édition unique : les 3 features Supporter sont LIVRÉES dans l'image (code présent),
    # même si leur activation dépend de la licence (entitled).
    installed = build_registry().installed_features()
    assert {FEATURE_PII_ADVANCED, FEATURE_MULTI_ENTITY, FEATURE_SCHEDULED_EXPORTS} <= installed
