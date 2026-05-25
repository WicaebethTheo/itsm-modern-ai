"""Port ITSM — seam minimal isolant tous les appels GLPI (addendum §A).

Trois opérations seulement, conçues pour accueillir l'API V2 plus tard sans
toucher au domaine. Lève les erreurs typées de `domain.errors` (jamais de crash).
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from ..domain.models import Referentials, Ticket, TicketStat


class ItsmPort(Protocol):
    async def get_new_tickets(self) -> list[Ticket]:
        """Tickets à l'état « New » (FR-2). Idempotence gérée en amont (poller)."""
        ...

    async def get_recent_tickets(self, since: datetime) -> list[TicketStat]:
        """Tickets créés/modifiés depuis `since` pour le Dashboard inversé (FR-23)."""
        ...

    async def get_referentials(self) -> Referentials:
        """Catégories, priorités, techniciens → constitution de la Whitelist (FR-3)."""
        ...

    async def write_followup(self, ticket_id: int, content: str, *, private: bool = True) -> int:
        """Écrit un Suivi interne privé (FR-4). Ne modifie AUCUN champ du Ticket."""
        ...

    async def healthcheck(self) -> bool:
        """True si GLPI est joignable et l'auth fonctionne (FR-27)."""
        ...
