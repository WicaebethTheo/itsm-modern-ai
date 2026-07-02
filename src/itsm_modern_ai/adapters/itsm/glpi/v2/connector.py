"""GlpiV2Connector — implémente `ItsmPort` via l'API haut-niveau GLPI 11 (OAuth2). **Beta**.

Même surface que le connecteur legacy (`GlpiConnector`), mais sur l'API V2 :
ressources namespacées (`/Assistance/Ticket`, `/Dropdowns/ITILCategory`,
`/Administration/User|Group|Entity`), recherche RSQL, mise à jour `PATCH`, acteurs via
`TeamMember`, suivis via `Timeline/Followup`.
"""

from __future__ import annotations

from datetime import datetime

import httpx

from .....config.credentials import GlpiV2Credentials
from .....domain.errors import ItsmError, ItsmUnavailableError
from .....domain.models import GlpiIdentity, Referentials, Ticket, TicketStat
from .....domain.models import Priority as _Priority
from . import mapper
from .client import GlpiV2Client

# Libellés FR des priorités (encodage stable, identique au connecteur legacy).
PRIORITY_LABELS_FR = {
    _Priority.VERY_LOW: "Très basse",
    _Priority.LOW: "Basse",
    _Priority.MEDIUM: "Moyenne",
    _Priority.HIGH: "Haute",
    _Priority.VERY_HIGH: "Très haute",
    _Priority.MAJOR: "Majeure",
}

_REF_HARD_CAP = 2000  # garde-fou de pagination des référentiels


class GlpiV2Connector:
    def __init__(
        self,
        creds: GlpiV2Credentials,
        *,
        max_tickets: int = 200,
        stats_max: int = 500,
        ssrf_guard: bool = False,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._creds = creds
        self._max_tickets = max_tickets
        self._stats_max = stats_max
        self._ssrf_guard = ssrf_guard
        self._http_client = http_client

    def _client(self) -> GlpiV2Client:
        return GlpiV2Client(self._creds, ssrf_guard=self._ssrf_guard, client=self._http_client)

    async def get_new_tickets(self) -> list[Ticket]:
        async with self._client() as gc:
            rows = await gc.search(
                "Assistance/Ticket",
                # `status` est un objet imbriqué {id,name} en V2 → filtre RSQL en dot-notation.
                filter=f"status.id=={mapper.STATUS_NEW}",
                sort="id:desc",
                limit=self._max_tickets,
            )
        # Filet : on revalide le statut côté domaine (le filtre RSQL fait l'essentiel).
        return [mapper.ticket_from_glpi(t) for t in rows if mapper.is_new(t)]

    async def get_recent_tickets(self, since: datetime) -> list[TicketStat]:
        async with self._client() as gc:
            rows = await gc.search(
                "Assistance/Ticket", sort="date_creation:desc", limit=self._stats_max
            )
        stats = [mapper.ticketstat_from_glpi(t) for t in rows]
        return [s for s in stats if s.created is None or s.created >= since]

    async def get_referentials(self) -> Referentials:
        async with self._client() as gc:
            categories_raw = await gc.search_all("Dropdowns/ITILCategory", hard_cap=_REF_HARD_CAP)
            users_raw = await gc.search_all("Administration/User", hard_cap=_REF_HARD_CAP)
            groups_raw = await gc.search_all("Administration/Group", hard_cap=_REF_HARD_CAP)
            entities_raw = await gc.search_all("Administration/Entity", hard_cap=_REF_HARD_CAP)
        categories = {
            int(c["id"]): str(c.get("completename") or c.get("name") or f"cat_{c['id']}")
            for c in categories_raw
            if c.get("id") is not None
        }
        technicians = {
            int(u["id"]): mapper.user_display(u)
            for u in users_raw
            if u.get("id") is not None and not _is_deleted(u)
        }
        groups = {
            int(g["id"]): str(g.get("completename") or g.get("name") or f"group_{g['id']}")
            for g in groups_raw
            if g.get("id") is not None
        }
        entities = {
            int(e["id"]): str(e.get("completename") or e.get("name") or f"entity_{e['id']}")
            for e in entities_raw
            if e.get("id") is not None
        }
        priorities = {int(p): label for p, label in PRIORITY_LABELS_FR.items()}
        # Profil par technicien (parité legacy) : en V2 chaque User expose son `default_profile`
        # {id,name}. On l'utilise comme profil affiché (le legacy joint TOUS les profils ;
        # la V2 n'expose que le profil par défaut → approximation raisonnable).
        technician_profiles = {
            int(u["id"]): str(u["default_profile"]["name"])
            for u in users_raw
            if u.get("id") is not None
            and isinstance(u.get("default_profile"), dict)
            and u["default_profile"].get("name")
        }
        return Referentials(
            categories=categories,
            technicians=technicians,
            groups=groups,
            entities=entities,
            technician_profiles=technician_profiles,
            priorities=priorities,
        )

    async def write_followup(self, ticket_id: int, content: str, *, private: bool = True) -> int:
        payload = mapper.followup_payload(content, private=private)
        async with self._client() as gc:
            body = (await gc.post(f"Assistance/Ticket/{ticket_id}/Timeline/Followup", json=payload)).json()
        if isinstance(body, list):
            body = body[0] if body else {}
        fid = body.get("id") if isinstance(body, dict) else None
        if fid is None:
            raise ItsmError(f"Écriture du Suivi V2 sans id retourné: {body}")
        return int(fid)

    async def apply_decision(
        self,
        ticket_id: int,
        *,
        category: int,
        priority: int,
        technician_id: int | None = None,
        group_id: int | None = None,
    ) -> None:
        """Mute le Ticket (PATCH catégorie/urgence/priorité) puis assigne un acteur (TeamMember)."""
        fields = mapper.ticket_update_payload(category=category, priority=priority)
        member = mapper.teammember_payload(technician_id=technician_id, group_id=group_id)
        async with self._client() as gc:
            await gc.patch(f"Assistance/Ticket/{ticket_id}", json=fields)
            if member is not None:
                await gc.post(f"Assistance/Ticket/{ticket_id}/TeamMember", json=member)

    async def healthcheck(self) -> bool:
        if not self._creds.is_configured:
            return False
        try:
            async with self._client() as gc:
                await gc.get("Administration/User/Me")
            return True
        except ItsmUnavailableError:
            return False
        except ItsmError:
            return False

    async def whoami(self) -> GlpiIdentity | None:
        """Compte GLPI courant (via `Administration/User/Me`) — aperçu UI. None si indéterminé."""
        if not self._creds.is_configured:
            return None
        try:
            async with self._client() as gc:
                data = (await gc.get("Administration/User/Me")).json()
        except (ItsmError, ItsmUnavailableError):
            return None
        if isinstance(data, list):
            data = data[0] if data else {}
        if not isinstance(data, dict) or not data:
            return None
        emails = data.get("emails")
        email = ""
        if isinstance(emails, list) and emails:
            first = emails[0]
            email = str(first.get("email") if isinstance(first, dict) else first)
        elif isinstance(emails, str):
            email = emails
        prof = data.get("default_profile")
        profile = str(prof.get("name")) if isinstance(prof, dict) and prof.get("name") else ""
        return GlpiIdentity(
            account=mapper.user_display(data),
            username=str(data.get("username") or ""),
            profile=profile,
            email=email,
            has_picture=bool(data.get("picture")),
        )

    async def avatar(self) -> tuple[bytes, str] | None:
        """Photo de profil via `Administration/User/Me/Picture` (V2). None si absente."""
        if not self._creds.is_configured:
            return None
        try:
            async with self._client() as gc:
                resp = await gc.get("Administration/User/Me/Picture")
        except (ItsmError, ItsmUnavailableError):
            return None
        content = resp.content
        if not content:
            return None
        return content, resp.headers.get("content-type", "image/png")

    @property
    def base_url(self) -> str:
        return self._creds.base_url

    async def server_version(self) -> str | None:
        """Version du serveur GLPI via `Setup/Config/core/version` (scope `api`). None sinon."""
        if not self._creds.is_configured:
            return None
        try:
            async with self._client() as gc:
                data = (await gc.get("Setup/Config/core/version")).json()
        except (ItsmError, ItsmUnavailableError):
            return None
        if isinstance(data, list):
            data = data[0] if data else {}
        value = data.get("value") if isinstance(data, dict) else None
        return str(value) if value else None


def _is_deleted(user: dict) -> bool:
    val = user.get("is_deleted")
    return str(val).lower() in ("1", "true") if val is not None else False
