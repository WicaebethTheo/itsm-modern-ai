"""Journal de décision (FR-20) : consultation triable + annotation manuelle."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ...persistence import journal
from ..deps import get_session
from ..security import require_auth

router = APIRouter(prefix="/api", tags=["journal"], dependencies=[Depends(require_auth)])


class DecisionEntry(BaseModel):
    id: int
    ticket_id: int
    ts: datetime
    accepted: bool
    reason: str
    category: int | None
    priority: int | None
    technician_id: int | None
    confidence: float | None
    glpi_link: str
    annotation: str


class AnnotationUpdate(BaseModel):
    annotation: str


@router.get("/decisions", response_model=list[DecisionEntry])
def list_decisions(limit: int = 500, session: Session = Depends(get_session)) -> list[DecisionEntry]:
    return [DecisionEntry.model_validate(d, from_attributes=True) for d in journal.list_decisions(session, limit=limit)]


@router.patch("/decisions/{decision_id}/annotation", response_model=DecisionEntry)
def annotate(
    decision_id: int, body: AnnotationUpdate, session: Session = Depends(get_session)
) -> DecisionEntry:
    row = journal.set_annotation(session, decision_id, body.annotation)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Décision introuvable."})
    return DecisionEntry.model_validate(row, from_attributes=True)
