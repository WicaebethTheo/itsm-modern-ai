"""GlpiConnector — implémente `ItsmPort` via l'API legacy apirest.php (FR-1→4)."""

from __future__ import annotations

from datetime import datetime

import httpx

from ....domain.errors import ItsmError, ItsmUnavailableError
from ....domain.models import Priority as _Priority
from ....domain.models import Referentials, Ticket, TicketStat
from ....services.runtime_config import GlpiCredentials
from . import mapper
from .client import GlpiClient

# Libellés FR des priorités (encodage stable, addendum §A).
PRIORITY_LABELS_FR = {
    _Priority.VERY_LOW: "Très basse",
    _Priority.LOW: "Basse",
    _Priority.MEDIUM: "Moyenne",
    _Priority.HIGH: "Haute",
    _Priority.VERY_HIGH: "Très haute",
    _Priority.MAJOR: "Majeure",
}


def _user_display(raw: dict) -> str:
    parts = [str(raw.get("firstname") or ""), str(raw.get("realname") or "")]
    full = " ".join(p for p in parts if p).strip()
    return full or str(raw.get("name") or f"user_{raw.get('id')}")


class GlpiConnector:
    def __init__(
        self,
        creds: GlpiCredentials,
        *,
        max_tickets: int = 200,
        stats_max: int = 500,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._creds = creds
        self._max_tickets = max_tickets
        self._stats_max = stats_max
        self._http_client = http_client

    def _client(self) -> GlpiClient:
        return GlpiClient(
            base_url=self._creds.base_url,
            user_token=self._creds.user_token,
            app_token=self._creds.app_token,
            verify_tls=self._creds.verify_tls,
            timeout=self._creds.timeout_seconds,
            client=self._http_client,
        )

    async def get_new_tickets(self) -> list[Ticket]:
        async with self._client() as gc:
            resp = await gc.get(
                "Ticket", params={"range": f"0-{self._max_tickets - 1}", "sort": "id", "order": "DESC"}
            )
            data = resp.json()
        if isinstance(data, dict):  # GLPI peut renvoyer un objet unique
            data = [data]
        return [mapper.ticket_from_glpi(t) for t in data if mapper.is_new(t)]

    async def get_recent_tickets(self, since: datetime) -> list[TicketStat]:
        """Tickets récents (créés ≥ since) pour le Dashboard inversé (FR-23)."""
        async with self._client() as gc:
            resp = await gc.get(
                "Ticket",
                params={"range": f"0-{self._stats_max - 1}", "sort": "date", "order": "DESC"},
            )
            data = resp.json()
        if isinstance(data, dict):
            data = [data]
        stats = [mapper.ticketstat_from_glpi(t) for t in data]
        return [s for s in stats if s.created is None or s.created >= since]

    async def get_referentials(self) -> Referentials:
        """Scan complet des référentiels GLPI : catégories, techniciens, groupes, entités."""
        async with self._client() as gc:
            categories_raw = _as_list((await gc.get("ITILCategory", params={"range": "0-999"})).json())
            users_raw = _as_list((await gc.get("User", params={"range": "0-999"})).json())
            groups_raw = _as_list((await gc.get("Group", params={"range": "0-999"})).json())
            entities_raw = _as_list((await gc.get("Entity", params={"range": "0-999"})).json())
        categories = {
            int(c["id"]): str(c.get("completename") or c.get("name") or f"cat_{c['id']}")
            for c in categories_raw
        }
        technicians = {int(u["id"]): _user_display(u) for u in users_raw}
        groups = {
            int(g["id"]): str(g.get("completename") or g.get("name") or f"group_{g['id']}")
            for g in groups_raw
        }
        entities = {
            int(e["id"]): str(e.get("completename") or e.get("name") or f"entity_{e['id']}")
            for e in entities_raw
        }
        priorities = {int(p): label for p, label in PRIORITY_LABELS_FR.items()}
        return Referentials(
            categories=categories,
            technicians=technicians,
            groups=groups,
            entities=entities,
            priorities=priorities,
        )

    async def write_followup(self, ticket_id: int, content: str, *, private: bool = True) -> int:
        itemtype = mapper.followup_itemtype(self._creds.followup_legacy_9x)
        payload = mapper.followup_payload(
            ticket_id, content, private=private, legacy_9x=self._creds.followup_legacy_9x
        )
        async with self._client() as gc:
            resp = await gc.post(itemtype, json=payload)
            body = resp.json()
        # GLPI renvoie {"id": N} (ou une liste d'objets en cas de batch).
        if isinstance(body, list):
            body = body[0] if body else {}
        fid = body.get("id")
        if fid is None:
            raise ItsmError(f"Écriture du Suivi sans id retourné: {body}")
        return int(fid)

    async def healthcheck(self) -> bool:
        if not self._creds.is_configured:
            return False
        try:
            async with self._client():
                return True
        except ItsmUnavailableError:
            return False
        except ItsmError:
            # Auth/permission KO mais GLPI répond → considéré non sain pour le pilote.
            return False


def _as_list(data: object) -> list[dict]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    return []
