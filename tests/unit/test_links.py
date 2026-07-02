"""Lien web (front GLPI) — helper partagé (journal + anomalies dashboard)."""

from __future__ import annotations

from itsm_modern_ai.services.links import ticket_web_link


def test_strips_apirest_suffix():
    assert (
        ticket_web_link("https://glpi.exemple.local/apirest.php", 42)
        == "https://glpi.exemple.local/front/ticket.form.php?id=42"
    )


def test_strips_api_php_suffix_and_trailing_slash():
    assert (
        ticket_web_link("https://glpi.exemple.local/api.php/", 7)
        == "https://glpi.exemple.local/front/ticket.form.php?id=7"
    )


def test_strips_versioned_api_php():
    """Nouvelle API GLPI versionnée (`api.php/v1`) : le lien doit viser l'UI web, pas l'API."""
    assert (
        ticket_web_link("https://glpi.exemple.local/api.php/v1", 123)
        == "https://glpi.exemple.local/front/ticket.form.php?id=123"
    )
    assert (
        ticket_web_link("https://glpi.exemple.local/api.php/v1/", 123)
        == "https://glpi.exemple.local/front/ticket.form.php?id=123"
    )


def test_empty_base_returns_empty():
    assert ticket_web_link("", 1) == ""
