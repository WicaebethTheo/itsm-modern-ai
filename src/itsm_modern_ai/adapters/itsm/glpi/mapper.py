"""Mapping GLPI ↔ domaine + encodages stables (addendum §A)."""

from __future__ import annotations

import html as _html
import re
from datetime import datetime

from ....domain.models import Ticket, TicketStat

STATUS_NEW = 1  # 1=New, 2=Assigned, 3=Planned, 4=Pending, 5=Solved, 6=Closed
# Nom du champ de statut côté API legacy — utilisé pour le filtrage SERVEUR
# (`searchText[status]`), afin que la fenêtre de lecture porte sur les seuls
# tickets pertinents et non sur l'ensemble des tickets tous statuts confondus.
STATUS_FIELD = "status"


# ── Normalisation du texte GLPI ────────────────────────────────────────────────
# GLPI stocke le texte des tickets en HTML (éditeur TinyMCE) : balisage `<p>`, `<br>`,
# et surtout des ENTITÉS — `&#039;` pour une apostrophe, `&nbsp;` pour une espace
# insécable. Or l'éditeur insère `&nbsp;` automatiquement, et la typographie française
# en met une AVANT les deux-points : « mot de passe&nbsp;: Azerty1234 » est donc la
# forme NORMALE d'un mot de passe collé dans un ticket, pas un cas tordu.
#
# ⚠️ C'est un défaut de MASQUAGE, pas de confort. Mesuré sur des données réelles :
#     « 06&nbsp;12&nbsp;34&nbsp;56&nbsp;78 »  → téléphone NON masqué
#     « mot de passe&nbsp;: Azerty1234 »      → secret NON masqué
# Les motifs du domaine attendent des espaces, pas des entités : sans normalisation,
# la donnée part EN CLAIR au LLM. Normaliser ICI — à la frontière de l'adaptateur, là
# où la représentation GLPI devient du texte du domaine — plutôt que d'apprendre le HTML
# aux regex de masquage, qui doivent rester pures et agnostiques de la source.
#
# Bénéfice second : le LLM reçoit du texte propre au lieu de `<p>` et `&#039;`, ce qui
# améliore la qualité du triage et économise des jetons.
_BR_RE = re.compile(r"(?i)<\s{0,4}br\s{0,4}/?\s{0,4}>")
_BLOCK_END_RE = re.compile(r"(?i)</\s{0,4}(p|div|li|tr|h[1-6])\s{0,4}>")
_TAG_RE = re.compile(r"<[^>]{0,2000}>")
_SPACES_RE = re.compile(r"[ \t\u00a0]{2,}")


def plain_text(raw_html: str) -> str:
    """Convertit le HTML d'un champ GLPI en texte simple, masquable et lisible.

    Quantificateurs BORNÉS (cf. le durcissement ReDoS du masquage) : le contenu vient du
    demandeur, il n'est pas fiable.
    """
    if not raw_html:
        return ""
    texte = _BR_RE.sub("\n", raw_html)
    texte = _BLOCK_END_RE.sub("\n", texte)
    texte = _TAG_RE.sub("", texte)
    # Les entités APRÈS le retrait des balises : `&lt;p&gt;` écrit par un utilisateur ne
    # doit pas devenir une balise que l'on retirerait ensuite.
    texte = _html.unescape(texte)
    # `&nbsp;` devient U+00A0 : on le ramène à une espace ordinaire, sinon les motifs de
    # masquage (qui attendent `\s` ou une espace) le manquent toujours.
    texte = texte.replace("\u00a0", " ")
    texte = _SPACES_RE.sub(" ", texte)
    return "\n".join(ligne.strip() for ligne in texte.split("\n")).strip()


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
        title=plain_text(str(raw.get("name") or "")),
        content=plain_text(str(raw.get("content") or "")),
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
