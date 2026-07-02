"""Mapper GLPI (FR-4) — encodage statut + payload Suivi (rename 9.x/10.x)."""

from __future__ import annotations

from itsm_modern_ai.adapters.itsm.glpi import mapper


def test_is_new_only_status_1():
    assert mapper.is_new({"status": 1})
    assert not mapper.is_new({"status": 2})
    assert not mapper.is_new({})


def test_ticket_mapping():
    t = mapper.ticket_from_glpi({"id": "42", "name": "Souci", "content": "PC lent"})
    assert t.id == 42
    assert t.title == "Souci"
    assert t.content == "PC lent"


def test_followup_itemtype_rename():
    assert mapper.followup_itemtype(False) == "ITILFollowup"  # 10.x+
    assert mapper.followup_itemtype(True) == "TicketFollowup"  # 9.x


def test_followup_payload_modern_uses_itemtype_items_id():
    p = mapper.followup_payload(7, "note", private=True, legacy_9x=False)["input"]
    assert p["itemtype"] == "Ticket"
    assert p["items_id"] == 7
    assert p["is_private"] == 1
    assert "tickets_id" not in p


def test_followup_payload_legacy_uses_tickets_id():
    p = mapper.followup_payload(7, "note", private=True, legacy_9x=True)["input"]
    assert p["tickets_id"] == 7
    assert "items_id" not in p
