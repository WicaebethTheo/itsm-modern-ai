"""Idempotence du polling (FR-2) — repo sur `processed_tickets`.

MARQUAGE EN DEUX TEMPS (0.9.56). Le poller appelait le handler PUIS posait le marqueur : un
arrêt brutal entre les deux laissait l'écriture GLPI faite sans trace locale, et le cycle
suivant rejouait le Ticket — en `full_auto`, une **seconde réponse publique au demandeur**.

    claim()          avant le handler   → la ligne existe quand l'écriture GLPI part
    mark_processed() après le cycle     → libère la réservation (claimed_at = None)
    release()        triage rejouable   → annule la réservation (Ticket repris au cycle suivant)

`release` n'est pas un détail : sans lui, une panne LLM de trois secondes brûlerait le Ticket
définitivement — une régression bien pire que le défaut corrigé.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlmodel import Session, select

from .tables import ProcessedTicket


def is_processed(session: Session, ticket_id: int) -> bool:
    """Vrai si le Ticket a été traité **ou réservé**.

    Une réservation orpheline (traitement interrompu) compte donc comme « traité » : c'est
    le comportement FAIL-CLOSED voulu. Rejouer un Ticket dont on ignore s'il a déjà reçu une
    réponse publique serait le pire des deux mondes.
    """
    return session.get(ProcessedTicket, ticket_id) is not None


def claim(session: Session, ticket_id: int) -> None:
    """Réserve le Ticket AVANT toute écriture GLPI. Idempotent."""
    row = session.get(ProcessedTicket, ticket_id) or ProcessedTicket(ticket_id=ticket_id)
    row.claimed_at = datetime.now(UTC)
    session.add(row)
    session.commit()


def release(session: Session, ticket_id: int) -> None:
    """Annule une réservation : le Ticket redevient éligible au prochain cycle.

    Réservé aux cas où le triage N'A PAS EU LIEU (panne LLM, sortie invalide, plafond) et où
    rien n'a donc été écrit dans GLPI. Ne JAMAIS l'appeler après une écriture réussie.
    """
    row = session.get(ProcessedTicket, ticket_id)
    if row is not None:
        session.delete(row)
        session.commit()


def interrupted(session: Session) -> list[int]:
    """Tickets dont le traitement a été interrompu en vol (réservation jamais libérée)."""
    return [
        r.ticket_id
        for r in session.exec(
            select(ProcessedTicket).where(ProcessedTicket.claimed_at.is_not(None))  # type: ignore[union-attr]
        ).all()
    ]


def mark_processed(
    session: Session, ticket_id: int, *, state_fingerprint: str = "", followup_written: bool = False
) -> None:
    """Pose le marqueur « traité » et LIBÈRE la réservation. Idempotent (upsert)."""
    row = session.get(ProcessedTicket, ticket_id)
    if row is None:
        row = ProcessedTicket(
            ticket_id=ticket_id,
            state_fingerprint=state_fingerprint,
            followup_written=followup_written,
        )
    else:
        row.state_fingerprint = state_fingerprint or row.state_fingerprint
        row.followup_written = followup_written or row.followup_written
    row.claimed_at = None  # cycle mené à son terme
    session.add(row)
    session.commit()
