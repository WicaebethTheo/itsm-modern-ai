"""Mapping GLPI ↔ domaine + encodages stables (addendum §A)."""

from __future__ import annotations

from ....domain.models import Ticket

STATUS_NEW = 1  # 1=New, 2=Assigned, 3=Planned, 4=Pending, 5=Solved, 6=Closed


def ticket_from_glpi(raw: dict) -> Ticket:
    """Construit un Ticket domaine depuis un objet Ticket GLPI (apirest.php)."""
    return Ticket(
        id=int(raw["id"]),
        title=str(raw.get("name") or ""),
        content=str(raw.get("content") or ""),
    )


def is_new(raw: dict) -> bool:
    try:
        return int(raw.get("status", 0)) == STATUS_NEW
    except (TypeError, ValueError):
        return False


def followup_itemtype(legacy_9x: bool) -> str:
    """Rename TicketFollowup→ITILFollowup entre 9.x et 10.x (FR-4)."""
    return "TicketFollowup" if legacy_9x else "ITILFollowup"


def followup_payload(ticket_id: int, content: str, *, private: bool, legacy_9x: bool) -> dict:
    """Payload d'écriture d'un Suivi. Aucun champ du Ticket n'est touché (mode suggestion)."""
    is_private = 1 if private else 0
    if legacy_9x:
        # GLPI 9.x : TicketFollowup, champ `tickets_id`.
        return {"input": {"tickets_id": ticket_id, "content": content, "is_private": is_private}}
    # GLPI 10.x+ : ITILFollowup polymorphe, `itemtype` + `items_id`.
    return {
        "input": {
            "itemtype": "Ticket",
            "items_id": ticket_id,
            "content": content,
            "is_private": is_private,
        }
    }
