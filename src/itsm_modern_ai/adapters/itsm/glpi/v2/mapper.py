"""Mapping API haut-niveau GLPI V2 ↔ domaine — **Beta**.

Spécificité V2 vs legacy : les dropdowns sont des **objets imbriqués `{id, name}`** (et non
des `*_id` plats), et les acteurs vivent dans un tableau **`team`** (`{id, type, role}`) au
lieu de `_users_id_assign`/`_groups_id_assign`.
"""

from __future__ import annotations

from datetime import UTC, datetime

from .....domain.models import Ticket, TicketStat

STATUS_NEW = 1  # 1=New, 2=Assigned, 3=Planned, 4=Pending, 5=Solved, 6=Closed


def _parse_dt(value: object) -> datetime | None:
    """Date GLPI V2 → datetime **naïf en UTC**.

    L'API V2 peut renvoyer des dates ISO timezone-aware ; on les ramène en naïf UTC pour
    rester comparable avec le reste du moteur (le Dashboard fournit un `since` naïf UTC, et
    le connecteur legacy produit aussi des dates naïves)."""
    if not value or value in ("0000-00-00 00:00:00", "0000-00-00"):
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _to_int(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def nested_id(value: object) -> int:
    """Id d'un champ lié V2 : objet `{id,name}` → id ; entier brut accepté ; 0 sinon."""
    if isinstance(value, dict):
        return _to_int(value.get("id")) or 0
    return _to_int(value) or 0


def nested_name(value: object, fallback: str = "") -> str:
    if isinstance(value, dict):
        return str(value.get("completename") or value.get("name") or fallback)
    return fallback


def status_id(value: object) -> int:
    """Statut V2 : objet `{id,name}` (lecture) → id ; entier accepté ; défaut New."""
    sid = nested_id(value)
    return sid if sid else STATUS_NEW


def _team(raw: dict) -> list[dict]:
    team = raw.get("team")
    return team if isinstance(team, list) else []


def has_assignee(raw: dict) -> bool:
    """Un acteur de rôle `assigned` (technicien ou groupe) est-il déjà posé ?"""
    return any(str(m.get("role") or "").lower() == "assigned" for m in _team(raw) if isinstance(m, dict))


def user_display(raw: dict) -> str:
    """Nom affichable d'un User V2 : « prénom nom », sinon username, sinon `user_<id>`."""
    parts = [str(raw.get("firstname") or ""), str(raw.get("realname") or "")]
    full = " ".join(p for p in parts if p).strip()
    return full or str(raw.get("username") or raw.get("name") or f"user_{raw.get('id')}")


def is_new(raw: dict) -> bool:
    return status_id(raw.get("status")) == STATUS_NEW


def ticket_from_glpi(raw: dict) -> Ticket:
    """Construit un Ticket domaine depuis un objet Ticket de l'API V2."""
    return Ticket(
        id=int(raw["id"]),
        title=str(raw.get("name") or ""),
        content=str(raw.get("content") or ""),
        status=status_id(raw.get("status")),
        entity_id=nested_id(raw.get("entity")),
        category_id=nested_id(raw.get("category")),
        assignee_present=has_assignee(raw),
    )


def ticketstat_from_glpi(raw: dict) -> TicketStat:
    """Mappe un Ticket V2 vers les stats du Dashboard inversé (FR-23)."""
    return TicketStat(
        id=int(raw["id"]),
        status=status_id(raw.get("status")),
        entity_id=nested_id(raw.get("entity")),
        created=_parse_dt(raw.get("date_creation") or raw.get("date")),
        solved=_parse_dt(raw.get("date_solve") or raw.get("solvedate")),
        time_to_resolve=_parse_dt(raw.get("time_to_resolve")),
        first_response_seconds=_to_int(raw.get("take_into_account_duration")),
    )


def ticket_update_payload(*, category: int, priority: int) -> dict:
    """Corps `PATCH Assistance/Ticket/{id}` (catégorie + urgence + priorité).

    V2 : pas d'enveloppe `input`. Les dropdowns sont des **objets imbriqués** → la catégorie
    s'écrit `{"id": <int>}` (le `name` est readOnly). On pose `urgency` (bornée 1..5) en plus
    de `priority` pour la même raison qu'en legacy (matrice urgence×impact côté GLPI).
    L'assignation d'acteurs se fait à part via la ressource `TeamMember`.
    """
    return {"category": {"id": category}, "priority": priority, "urgency": min(priority, 5)}


def teammember_payload(*, technician_id: int | None, group_id: int | None) -> dict | None:
    """Corps `POST Assistance/Ticket/{id}/TeamMember` : technicien (préféré) ou groupe.

    `{type: User|Group, id, role: assigned}`. None si aucun acteur à poser.
    """
    if technician_id is not None:
        return {"type": "User", "id": technician_id, "role": "assigned"}
    if group_id is not None:
        return {"type": "Group", "id": group_id, "role": "assigned"}
    return None


def followup_payload(content: str, *, private: bool) -> dict:
    """Corps `POST …/Timeline/Followup` (l'item parent est porté par l'URL)."""
    return {"content": content, "is_private": private}
