"""Idempotence du polling (FR-2) — repo sur `processed_tickets`."""

from __future__ import annotations

from sqlmodel import Session

from .tables import ProcessedTicket


def is_processed(session: Session, ticket_id: int) -> bool:
    return session.get(ProcessedTicket, ticket_id) is not None


def mark_processed(
    session: Session, ticket_id: int, *, state_fingerprint: str = "", followup_written: bool = False
) -> None:
    """Pose le marqueur « traité ». Idempotent (upsert sur ticket_id)."""
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
    session.add(row)
    session.commit()
