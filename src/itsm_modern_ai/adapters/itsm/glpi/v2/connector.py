"""GlpiV2Connector — implémente `ItsmPort` via l'API haut-niveau GLPI 11 (OAuth2). **Beta**.

Même surface que le connecteur legacy (`GlpiConnector`), mais sur l'API V2 :
ressources namespacées (`/Assistance/Ticket`, `/Dropdowns/ITILCategory`,
`/Administration/User|Group|Entity`), recherche RSQL, mise à jour `PATCH`, acteurs via
`TeamMember`, suivis via `Timeline/Followup`.
"""

from __future__ import annotations

import logging
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

logger = logging.getLogger("itsm.glpi.v2")


class ItsmPartialApplyError(ItsmError):
    """`apply_decision` s'est arrêtée APRÈS avoir muté le Ticket (mutation partielle).

    L'API V2 n'est pas transactionnelle : appliquer une Décision demande DEUX appels
    réseau (PATCH des champs, puis POST `TeamMember` pour l'acteur). Si le second
    échoue, le Ticket est DÉJÀ modifié dans GLPI — l'hypothèse « si apply échoue,
    rien n'a été muté » (vraie en legacy, un seul PATCH) ne tient plus.

    On ne peut pas rendre GLPI transactionnel ; on rend l'état **reconnaissable** :
    l'attribut `partial_mutation` permet au moteur de triage de distinguer « rien
    n'a bougé, on peut rejouer » de « GLPI a bougé, il faut journaliser et NE PAS
    rejouer » (sinon le Ticket serait re-muté et re-facturé à chaque cycle, sans
    la moindre ligne au Journal).

    Le marqueur est un ATTRIBUT (et non un type importé par le service) pour que
    `services/triage.py` n'ait pas à dépendre d'un adaptateur concret.
    """

    partial_mutation = True


class GlpiV2Connector:
    def __init__(
        self,
        creds: GlpiV2Credentials,
        *,
        max_tickets: int = 200,
        stats_max: int = 500,
        ssrf_guard: bool = False,
        allow_local: bool = False,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._creds = creds
        self._max_tickets = max_tickets
        self._stats_max = stats_max
        self._ssrf_guard = ssrf_guard
        # On-premise : GLPI 11 peut vivre sur une IP/host privé → tolérance ciblée GLPI
        # pour le garde anti-SSRF (settings.glpi_allow_private_host).
        self._allow_local = allow_local
        self._http_client = http_client

    def _client(self) -> GlpiV2Client:
        return GlpiV2Client(
            self._creds,
            ssrf_guard=self._ssrf_guard,
            allow_local=self._allow_local,
            client=self._http_client,
        )

    async def get_new_tickets(self) -> list[Ticket]:
        async with self._client() as gc:
            rows = await gc.search(
                "Assistance/Ticket",
                # `status` est un objet imbriqué {id,name} en V2 → filtre RSQL en dot-notation.
                filter=f"status.id=={mapper.STATUS_NEW}",
                # ASCENDANT : l'arriéré d'abord. En `desc`, les tickets « Nouveau » les plus
                # ANCIENS restaient hors fenêtre tant que des plus récents la remplissaient —
                # or c'est précisément le stock que le client attend de voir traiter le jour
                # de la mise en service. Cohérent avec le connecteur legacy.
                sort="id:asc",
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
        """Mute le Ticket (PATCH catégorie/urgence/priorité) puis assigne un acteur (TeamMember).

        DEUX appels réseau, donc DEUX issues d'échec très différentes :
        - le PATCH échoue → rien n'a été muté, l'erreur remonte telle quelle et le
          Ticket est rejouable au cycle suivant sans état partiel ;
        - le PATCH passe mais le POST `TeamMember` échoue → le Ticket est **déjà**
          catégorisé/priorisé dans GLPI sans acteur assigné. On lève alors une
          `ItsmPartialApplyError` qui NOMME l'état atteint : le moteur la journalise
          au lieu de laisser le Ticket boucler (re-mutation + re-facturation à chaque
          cycle, sans aucune trace d'audit).
        """
        fields = mapper.ticket_update_payload(category=category, priority=priority)
        member = mapper.teammember_payload(technician_id=technician_id, group_id=group_id)
        async with self._client() as gc:
            await gc.patch(f"Assistance/Ticket/{ticket_id}", json=fields)
            if member is None:
                return
            try:
                await gc.post(f"Assistance/Ticket/{ticket_id}/TeamMember", json=member)
            except Exception as exc:
                logger.error(
                    "apply_decision V2: mutation PARTIELLE du ticket %s — catégorie=%s "
                    "priorité=%s appliquées, acteur %s NON assigné (%s)",
                    ticket_id, category, priority, member, exc,
                )
                raise ItsmPartialApplyError(
                    f"Ticket {ticket_id} muté (catégorie={category}, priorité={priority}) "
                    f"mais assignation de l'acteur échouée: {exc}"
                ) from exc

    async def assign_actor(
        self, ticket_id: int, *, technician_id: int | None = None, group_id: int | None = None
    ) -> None:
        """Repli de triage : POST TeamMember SEUL, sans PATCH des champs.

        Un seul appel réseau sur le chemin nominal, donc AUCUN état partiel possible —
        contrairement à `apply_decision` qui doit composer avec un PATCH réussi suivi d'un
        POST échoué.

        IDEMPOTENCE (défaut trouvé en validation contre un GLPI 11 réel, pas par les mocks).
        `POST TeamMember` sur un acteur DÉJÀ assigné répond `400 ERROR_INVALID_PARAMETER`.
        Le cas est courant en production : une règle GLPI pré-affecte un groupe par défaut
        sans poser de catégorie, le Ticket n'est donc pas « déjà traité » (`rules_fully_handled`
        exige les deux), il part au moteur, se fait refuser — et le repli tente d'assigner un
        groupe qui y est déjà. Sans ce rattrapage, chaque Ticket de ce type produisait un
        WARNING et un `fallback_applied=False` alors que l'état visé était ATTEINT.

        On ne se fie pas au code d'erreur (`ERROR_INVALID_PARAMETER` est générique et
        couvrirait d'autres fautes) : on relit l'ÉTAT. Si l'acteur visé est présent, l'objectif
        est atteint, on rend la main. Sinon l'erreur d'origine repart telle quelle. Le chemin
        nominal, lui, ne paie aucun appel supplémentaire.

        (Le connecteur legacy n'a pas ce problème — VÉRIFIÉ, plus seulement raisonné : trois
        `assign_actor` identiques contre un `apirest.php` réel passent tous, et le groupe
        n'apparaît qu'une fois dans `Group_Ticket`. Le `PUT Ticket` est bien une mise à jour
        idempotente, là où le `POST TeamMember` de la V2 est une insertion.)
        """
        member = mapper.teammember_payload(technician_id=technician_id, group_id=group_id)
        if member is None:
            return
        async with self._client() as gc:
            try:
                await gc.post(f"Assistance/Ticket/{ticket_id}/TeamMember", json=member)
            except Exception:
                if not await self._acteur_deja_assigne(gc, ticket_id, member):
                    raise
                logger.info(
                    "assign_actor V2: %s #%s déjà assigné au ticket %s — état visé atteint",
                    member.get("type"), member.get("id"), ticket_id,
                )

    async def _acteur_deja_assigne(self, gc, ticket_id: int, member: dict) -> bool:
        """L'acteur visé figure-t-il déjà dans l'équipe du Ticket ?

        Best-effort et DÉFENSIF : si la relecture échoue (réseau, droits), on renvoie False
        pour que l'erreur d'origine — la vraie information — remonte intacte. Avaler un échec
        d'assignation en le déguisant en succès serait bien pire que le signaler à tort.
        """
        try:
            equipe = (await gc.get(f"Assistance/Ticket/{ticket_id}/TeamMember")).json()
        except Exception:
            return False
        if not isinstance(equipe, list):
            return False
        return any(
            isinstance(m, dict)
            and m.get("type") == member.get("type")
            and m.get("id") == member.get("id")
            for m in equipe
        )

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
