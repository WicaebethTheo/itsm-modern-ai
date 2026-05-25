"""Journal de décision + log des appels LLM (FR-19/20/21)."""

from __future__ import annotations

import csv
import io

from sqlmodel import Session, func, select

from ..domain.models import TriageOutcome
from .tables import DecisionLog, LlmCall


def record_llm_call(
    session: Session,
    *,
    ticket_id: int,
    model: str,
    prompt_sent: str,
    response_received: str,
    prompt_tokens: int,
    completion_tokens: int,
    cost_eur: float,
) -> None:
    """Journalise un appel LLM (FR-19). `prompt_sent` DOIT être masqué."""
    session.add(
        LlmCall(
            ticket_id=ticket_id,
            model=model,
            prompt_sent=prompt_sent,
            response_received=response_received,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cost_eur=cost_eur,
        )
    )
    session.commit()


def record_decision(
    session: Session, ticket_id: int, outcome: TriageOutcome, *, glpi_link: str = ""
) -> int:
    """Consigne une Décision (acceptée ou « à trier ») dans le Journal (FR-20)."""
    d = outcome.decision
    row = DecisionLog(
        ticket_id=ticket_id,
        accepted=outcome.accepted,
        reason=outcome.reason.value,
        category=d.category if d else None,
        priority=d.priority if d else None,
        technician_id=d.technician_id if d else None,
        confidence=d.confidence if d else None,
        glpi_link=glpi_link,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row.id  # type: ignore[return-value]


def list_decisions(session: Session, *, limit: int = 500) -> list[DecisionLog]:
    return list(
        session.exec(select(DecisionLog).order_by(DecisionLog.ts.desc()).limit(limit)).all()
    )


def set_annotation(session: Session, decision_id: int, annotation: str) -> DecisionLog | None:
    row = session.get(DecisionLog, decision_id)
    if row is None:
        return None
    row.annotation = annotation
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def count_llm_calls(session: Session) -> int:
    return int(session.exec(select(func.count()).select_from(LlmCall)).one())


def decisions_csv(session: Session) -> str:
    """Export CSV du Journal pour la DPO (FR-21). Aucune métrique nominative."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["id", "ticket_id", "ts", "accepted", "reason", "category", "priority",
         "technician_id", "confidence", "glpi_link", "annotation"]
    )
    for d in list_decisions(session, limit=100_000):
        writer.writerow(
            [d.id, d.ticket_id, d.ts.isoformat(), d.accepted, d.reason, d.category,
             d.priority, d.technician_id, d.confidence, d.glpi_link, d.annotation]
        )
    return buf.getvalue()


def llm_calls_csv(session: Session) -> str:
    """Export CSV des appels LLM (FR-19/21). Contenu déjà masqué."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["id", "ticket_id", "ts", "model", "prompt_sent", "response_received",
         "prompt_tokens", "completion_tokens", "cost_eur"]
    )
    rows = session.exec(select(LlmCall).order_by(LlmCall.ts.desc())).all()
    for c in rows:
        writer.writerow(
            [c.id, c.ticket_id, c.ts.isoformat(), c.model, c.prompt_sent, c.response_received,
             c.prompt_tokens, c.completion_tokens, c.cost_eur]
        )
    return buf.getvalue()
