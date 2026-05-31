"""Loader à plugins (entry points) — registre des features Enterprise installées."""

from __future__ import annotations

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


def test_community_image_has_no_enterprise_plugins():
    # Dans l'environnement de test (package Enterprise non installé), aucun plugin.
    assert build_registry().installed_features() == frozenset()
