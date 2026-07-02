"""Boucle de polling idempotente (FR-2) + rafraîchissement Whitelist (FR-3).

Garanties (NFR3) : aucun Ticket neuf perdu si GLPI est indisponible (reprise au
cycle suivant) ; aucun retraitement (idempotence `processed_tickets`) ; aucun crash
bloquant la file (les erreurs d'un Ticket n'arrêtent pas les autres).

Le `handler` est le seam de l'Epic 3 (masquage → LLM → whitelist → Suivi). En Epic 2,
il est absent : le poller établit seulement la plomberie « le Ticket entre ».
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass

from sqlmodel import Session

from ..domain.errors import ItsmError
from ..domain.models import Referentials, Ticket
from ..persistence import db, idempotency
from ..ports.itsm import ItsmPort
from ..services.whitelist_cache import WhitelistCache

logger = logging.getLogger("itsm.poller")

TicketHandler = Callable[[Ticket, Referentials], Awaitable[bool]]
SessionFactory = Callable[[], AbstractContextManager[Session]]


@dataclass
class PollStats:
    fetched: int = 0
    processed_new: int = 0
    skipped_already_done: int = 0
    skipped_out_of_scope: int = 0  # entité hors périmètre sélectionné (Story 5.4)
    errors: int = 0


@contextmanager
def _default_session() -> Iterator[Session]:
    with db.session_scope() as s:
        yield s


class TriagePoller:
    def __init__(
        self,
        itsm: ItsmPort,
        whitelist_cache: WhitelistCache,
        *,
        handler: TicketHandler | None = None,
        session_factory: SessionFactory = _default_session,
        referentials_loader: Callable[[], Referentials] | None = None,
    ) -> None:
        self._itsm = itsm
        self._cache = whitelist_cache
        self._handler = handler
        self._session_factory = session_factory
        # En prod : périmètre EFFECTIF (sélections admin en base). Défaut (tests) : GLPI.
        self._referentials_loader = referentials_loader

    async def _load_referentials(self) -> Referentials:
        if self._referentials_loader is not None:
            return self._referentials_loader()
        return await self._itsm.get_referentials()

    async def poll_once(self) -> PollStats:
        stats = PollStats()

        # 1) Charger la Whitelist effective (FR-3/FR-7). Échec → cycle sauté proprement.
        try:
            self._cache.refresh(await self._load_referentials())
        except ItsmError as exc:
            logger.warning("poll: référentiels indisponibles, cycle sauté: %s", exc)
            return stats

        # 2) Lire les Tickets « New » (FR-2). Indispo → reprise au cycle suivant.
        try:
            tickets = await self._itsm.get_new_tickets()
        except ItsmError as exc:
            logger.warning("poll: lecture des tickets impossible, cycle sauté: %s", exc)
            return stats

        stats.fetched = len(tickets)
        scope_entities = self._cache.referentials.entities  # vide = toutes (défaut sûr)
        for ticket in tickets:
            try:
                # Filtrage par périmètre d'entité (Story 5.4) : on ne marque PAS « traité »
                # pour qu'un Ticket soit repris si l'admin élargit le périmètre ensuite.
                if scope_entities and ticket.entity_id not in scope_entities:
                    stats.skipped_out_of_scope += 1
                    continue

                with self._session_factory() as session:
                    if idempotency.is_processed(session, ticket.id):
                        stats.skipped_already_done += 1
                        continue

                wrote_followup = False
                if self._handler is not None:
                    wrote_followup = await self._handler(ticket, self._cache.referentials)

                with self._session_factory() as session:
                    idempotency.mark_processed(session, ticket.id, followup_written=wrote_followup)
                stats.processed_new += 1
            except Exception as exc:  # un Ticket en erreur ne bloque pas les autres
                stats.errors += 1
                logger.exception("poll: erreur sur le Ticket %s: %s", ticket.id, exc)

        logger.info(
            "poll terminé: fetched=%d new=%d skip=%d hors_périmètre=%d err=%d",
            stats.fetched,
            stats.processed_new,
            stats.skipped_already_done,
            stats.skipped_out_of_scope,
            stats.errors,
        )
        return stats
