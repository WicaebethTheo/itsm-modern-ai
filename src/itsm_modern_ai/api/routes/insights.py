"""Endpoint JSON pour l'UI : métriques dashboard (FR-23)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from ...persistence import journal
from ...services import cost_cap
from ..deps import get_session
from ..security import require_auth

router = APIRouter(prefix="/api", tags=["insights"], dependencies=[Depends(require_auth)])


class Metrics(BaseModel):
    total: int
    accepted: int
    a_trier: int
    useful_coverage: float
    by_reason: dict[str, int]
    llm_calls: int
    cost_eur_last_24h: float
    cost_cap_eur_per_day: float


@router.get("/metrics", response_model=Metrics)
def metrics(request: Request, session: Session = Depends(get_session)) -> Metrics:
    """Métriques d'équipe (jamais par technicien — anti-mouchard, FR-18/21)."""
    stats = journal.decision_stats(session)
    return Metrics(
        **stats,
        llm_calls=journal.count_llm_calls(session),
        cost_eur_last_24h=round(cost_cap.spent_last_24h(session), 4),
        cost_cap_eur_per_day=request.app.state.settings.cost_cap_eur_per_day,
    )
