"""GlpiConnector — implémente `ItsmPort` via l'API legacy apirest.php (FR-1→4)."""

from __future__ import annotations

from datetime import datetime

import httpx

from ....config.credentials import GlpiCredentials
from ....domain.errors import ItsmError, ItsmUnavailableError
from ....domain.models import GlpiIdentity, Referentials, Ticket, TicketStat
from ....domain.models import Priority as _Priority
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


def _build_user_profiles(profiles_raw: list[dict], profile_user_raw: list[dict]) -> dict[int, str]:
    """Associe à chaque utilisateur ses profils GLPI (libellés joints, triés, dédupliqués)."""
    profile_names = {int(p["id"]): str(p.get("name") or f"profil_{p['id']}") for p in profiles_raw}
    by_user: dict[int, set[str]] = {}
    for pu in profile_user_raw:
        try:
            uid = int(pu["users_id"])
            pid = int(pu["profiles_id"])
        except (KeyError, TypeError, ValueError):
            continue
        by_user.setdefault(uid, set()).add(profile_names.get(pid, f"profil_{pid}"))
    return {uid: ", ".join(sorted(names)) for uid, names in by_user.items()}


class GlpiConnector:
    def __init__(
        self,
        creds: GlpiCredentials,
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

    def _client(self) -> GlpiClient:
        return GlpiClient(
            base_url=self._creds.base_url,
            user_token=self._creds.user_token,
            app_token=self._creds.app_token,
            verify_tls=self._creds.verify_tls,
            timeout=self._creds.timeout_seconds,
            ssrf_guard=self._ssrf_guard,
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
        """Scan complet des référentiels GLPI : catégories, techniciens, groupes, entités.

        Récupère aussi le(s) profil(s) GLPI de chaque utilisateur (best-effort) pour le
        tri/filtre par profil côté UI.
        """
        async with self._client() as gc:
            categories_raw = _as_list((await gc.get("ITILCategory", params={"range": "0-999"})).json())
            users_raw = _as_list((await gc.get("User", params={"range": "0-999"})).json())
            groups_raw = _as_list((await gc.get("Group", params={"range": "0-999"})).json())
            entities_raw = _as_list((await gc.get("Entity", params={"range": "0-999"})).json())
            try:  # profils : non bloquant si le token n'y a pas accès
                profiles_raw = _as_list((await gc.get("Profile", params={"range": "0-999"})).json())
                profile_user_raw = _as_list(
                    (await gc.get("Profile_User", params={"range": "0-999"})).json()
                )
            except ItsmError:
                profiles_raw, profile_user_raw = [], []
        categories = {
            int(c["id"]): str(c.get("completename") or c.get("name") or f"cat_{c['id']}")
            for c in categories_raw
        }
        # On exclut les comptes supprimés (GLPI renvoie tous les utilisateurs).
        technicians = {
            int(u["id"]): mapper.user_display(u)
            for u in users_raw
            if str(u.get("is_deleted") or "0") in ("0", "False", "false", "")
        }
        groups = {
            int(g["id"]): str(g.get("completename") or g.get("name") or f"group_{g['id']}")
            for g in groups_raw
        }
        entities = {
            int(e["id"]): str(e.get("completename") or e.get("name") or f"entity_{e['id']}")
            for e in entities_raw
        }
        technician_profiles = _build_user_profiles(profiles_raw, profile_user_raw)
        priorities = {int(p): label for p, label in PRIORITY_LABELS_FR.items()}
        return Referentials(
            categories=categories,
            technicians=technicians,
            groups=groups,
            entities=entities,
            technician_profiles=technician_profiles,
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

    async def apply_decision(
        self,
        ticket_id: int,
        *,
        category: int,
        priority: int,
        technician_id: int | None = None,
        group_id: int | None = None,
    ) -> None:
        """Mute le Ticket (catégorie, priorité, assignation) — modes semi/full-auto (FR-17)."""
        payload = mapper.ticket_update_payload(
            category=category, priority=priority, technician_id=technician_id, group_id=group_id
        )
        async with self._client() as gc:
            await gc.put(f"Ticket/{ticket_id}", json=payload)

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

    async def whoami(self) -> GlpiIdentity | None:
        """Compte GLPI du token (via `getFullSession`) — aperçu UI. None si indéterminé."""
        if not self._creds.is_configured:
            return None
        try:
            async with self._client() as gc:
                data = (await gc.get("getFullSession")).json()
        except (ItsmError, ItsmUnavailableError):
            return None
        session = data.get("session") if isinstance(data, dict) else None
        if not isinstance(session, dict):
            return None
        name = session.get("glpifriendlyname") or session.get("glpiname")
        if not name:
            return None
        prof = session.get("glpiactiveprofile")
        profile = str(prof.get("name")) if isinstance(prof, dict) and prof.get("name") else ""
        return GlpiIdentity(
            account=str(name),
            username=str(session.get("glpiname") or ""),
            profile=profile,
            email=str(session.get("glpiemail") or session.get("glpidefault_email") or ""),
            has_picture=False,  # legacy : pas d'endpoint binaire propre → avatar à initiales
        )

    async def avatar(self) -> tuple[bytes, str] | None:
        """Legacy : pas d'endpoint photo fiable via apirest.php → None (UI = initiales)."""
        return None

    @property
    def base_url(self) -> str:
        return self._creds.base_url

    async def server_version(self) -> str | None:
        """Version du serveur GLPI via `getGlpiConfig` (best-effort, None si indisponible)."""
        if not self._creds.is_configured:
            return None
        try:
            async with self._client() as gc:
                data = (await gc.get("getGlpiConfig")).json()
        except (ItsmError, ItsmUnavailableError):
            return None
        cfg = data.get("cfg_glpi") if isinstance(data, dict) else None
        version = cfg.get("version") if isinstance(cfg, dict) else None
        return str(version) if version else None


def _as_list(data: object) -> list[dict]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    return []
