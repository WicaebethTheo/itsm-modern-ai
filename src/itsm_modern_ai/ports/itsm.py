"""Port ITSM — seam minimal isolant tous les appels GLPI (addendum §A).

Trois opérations seulement, conçues pour accueillir l'API V2 plus tard sans
toucher au domaine. Lève les erreurs typées de `domain.errors` (jamais de crash).
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from ..domain.models import GlpiIdentity, Referentials, Ticket, TicketStat


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

    async def apply_decision(
        self,
        ticket_id: int,
        *,
        category: int,
        priority: int,
        technician_id: int | None = None,
        group_id: int | None = None,
    ) -> None:
        """Applique la Décision aux champs du Ticket (catégorie, priorité, assignation).

        ⚠️ MUTE le Ticket GLPI. Appelée UNIQUEMENT hors mode suggestion (semi/full-auto),
        après le garde-fou déterministe (whitelist + seuil). Le routage vise un technicien
        (préféré) ou, en fallback, un groupe éligible.
        """
        ...

    async def assign_actor(
        self, ticket_id: int, *, technician_id: int | None = None, group_id: int | None = None
    ) -> None:
        """Assigne un acteur SANS toucher à la catégorie ni à la priorité (repli de triage).

        DEUXIÈME porte de mutation, ouverte délibérément — l'invariant « une seule porte »
        a été précisé, pas contourné (cf. `docs/project-context.md`). Deux raisons de ne
        PAS réutiliser `apply_decision` :

        1. **Router n'est pas classer.** Un repli s'applique à une Décision que le garde-fou
           a REFUSÉE : sa confiance est basse sur l'ENSEMBLE de la Décision, donc poser sa
           catégorie serait pire que ne rien poser (elle serait crue par les stats, les
           règles GLPI et le technicien). Élargir `apply_decision` à des champs optionnels
           aurait fait d'une méthode « applique une Décision acceptée » un couteau suisse
           dont l'appelant décide des invariants — exactement ce qu'un port doit empêcher.
        2. **Un seul appel réseau.** En V2, `apply_decision` fait PATCH puis POST : le
           `ItsmPartialApplyError` n'existe que parce que le premier peut réussir et le
           second échouer. Ici il n'y a QUE l'assignation : soit elle passe, soit rien n'a
           bougé — pas d'état partiel possible.

        L'appelant garantit que l'acteur est éligible (défense en profondeur côté domaine).
        """
        ...

    async def healthcheck(self) -> bool:
        """True si GLPI est joignable et l'auth fonctionne (FR-27)."""
        ...

    async def whoami(self) -> GlpiIdentity | None:
        """Compte GLPI sous lequel le bot agit, None si indéterminé.

        Sert d'aperçu côté UI : « quel compte le bot utilise-t-il ? ». Best-effort —
        ne lève pas (retourne None sur échec d'auth/réseau)."""
        ...

    async def avatar(self) -> tuple[bytes, str] | None:
        """Photo de profil du compte (octets, content-type), None si indisponible.

        Récupérable proprement en V2 (`User/Me/Picture`). En legacy : généralement None
        (pas d'endpoint binaire) → l'UI retombe sur un avatar à initiales. Best-effort."""
        ...
