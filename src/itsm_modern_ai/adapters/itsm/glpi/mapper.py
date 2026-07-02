"""Mapping GLPI ↔ domaine + encodages stables (addendum §A)."""

from __future__ import annotations

from datetime import datetime

from ....domain.models import Ticket, TicketStat

STATUS_NEW = 1  # 1=New, 2=Assigned, 3=Planned, 4=Pending, 5=Solved, 6=Closed


def _parse_dt(value: object) -> datetime | None:
    """Parse une date GLPI ('YYYY-MM-DD HH:MM:SS'). None si absente/invalide."""
    if not value or value in ("0000-00-00 00:00:00", "0000-00-00"):
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _to_int(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def user_display(raw: dict) -> str:
    """Nom affichable d'un utilisateur GLPI : « prénom nom », sinon login, sinon `user_<id>`."""
    parts = [str(raw.get("firstname") or ""), str(raw.get("realname") or "")]
    full = " ".join(p for p in parts if p).strip()
    return full or str(raw.get("name") or f"user_{raw.get('id')}")


def ticketstat_from_glpi(raw: dict) -> TicketStat:
    """Mappe un Ticket GLPI vers les stats du Dashboard inversé (FR-23)."""
    return TicketStat(
        id=int(raw["id"]),
        status=int(raw.get("status") or STATUS_NEW),
        entity_id=int(raw.get("entities_id") or 0),
        created=_parse_dt(raw.get("date")),
        solved=_parse_dt(raw.get("solvedate")),
        time_to_resolve=_parse_dt(raw.get("time_to_resolve")),
        first_response_seconds=_to_int(raw.get("takeintoaccount_delay_stat")),
    )


def _has_assignee(raw: dict) -> bool:
    """Best-effort : un technicien/groupe assigné est-il déjà posé ?"""
    for key in ("_users_id_assign", "users_id_assign", "_groups_id_assign", "groups_id_assign"):
        val = raw.get(key)
        if isinstance(val, list):
            if any(v for v in val):
                return True
        elif val:
            try:
                if int(val) > 0:
                    return True
            except (TypeError, ValueError):
                return True
    return False


def ticket_from_glpi(raw: dict) -> Ticket:
    """Construit un Ticket domaine depuis un objet Ticket GLPI (apirest.php)."""
    try:
        category_id = int(raw.get("itilcategories_id") or 0)
    except (TypeError, ValueError):
        category_id = 0
    try:
        entity_id = int(raw.get("entities_id") or 0)
    except (TypeError, ValueError):
        entity_id = 0
    return Ticket(
        id=int(raw["id"]),
        title=str(raw.get("name") or ""),
        content=str(raw.get("content") or ""),
        status=int(raw.get("status") or STATUS_NEW),
        entity_id=entity_id,
        category_id=category_id,
        assignee_present=_has_assignee(raw),
    )


def is_new(raw: dict) -> bool:
    try:
        return int(raw.get("status", 0)) == STATUS_NEW
    except (TypeError, ValueError):
        return False


def followup_itemtype(legacy_9x: bool) -> str:
    """Rename TicketFollowup→ITILFollowup entre 9.x et 10.x (FR-4)."""
    return "TicketFollowup" if legacy_9x else "ITILFollowup"


def ticket_update_payload(
    *, category: int, priority: int, technician_id: int | None = None, group_id: int | None = None
) -> dict:
    """Payload `PUT Ticket/:id` appliquant une Décision (modes semi/full-auto).

    Mute la catégorie, l'**urgence** + la **priorité**, et assigne un acteur : technicien
    (préféré) ou, en fallback, un groupe.

    GLPI calcule fréquemment `priority` = matrice(`urgency` × `impact`) : poser `priority`
    seul peut être recalculé/ignoré et ne change pas l'urgence affichée. On pose donc aussi
    `urgency` (dérivée du niveau proposé, bornée à 1-5 car l'urgence GLPI n'a pas de « Majeure »)
    pour que l'urgence visible bouge et que la matrice remonte la priorité ; `priority` couvre
    le cas où la matrice est désactivée. Assignation via `_users_id_assign`/`_groups_id_assign`
    (acteurs en update, addendum §A — isolé ici pour adaptation sans toucher au connecteur).
    """
    inp: dict = {
        "itilcategories_id": category,
        "priority": priority,
        "urgency": min(priority, 5),  # GLPI urgency ∈ 1..5 ; MAJEURE (6) → Très haute (5)
    }
    if technician_id is not None:
        inp["_users_id_assign"] = technician_id
    elif group_id is not None:
        inp["_groups_id_assign"] = group_id
    return {"input": inp}


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
