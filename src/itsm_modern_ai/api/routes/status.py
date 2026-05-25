"""Statut runtime du moteur (FR-27, observabilité minimale) + compteurs (FR-10)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from ...persistence import journal
from ...services import cost_cap
from ..deps import get_session

router = APIRouter(prefix="/api", tags=["status"])


class Status(BaseModel):
    polling_enabled: bool
    polling_interval_seconds: int
    whitelist_loaded: bool
    categories_count: int
    technicians_count: int
    llm_calls_total: int
    cost_eur_last_24h: float
    cost_cap_eur_per_day: float


@router.get("/status", response_model=Status)
def status(request: Request, session: Session = Depends(get_session)) -> Status:
    settings = request.app.state.settings
    cache = request.app.state.whitelist_cache
    refs = cache.referentials
    return Status(
        polling_enabled=settings.polling_enabled,
        polling_interval_seconds=settings.polling_interval_seconds,
        whitelist_loaded=cache.is_loaded,
        categories_count=len(refs.categories),
        technicians_count=len(refs.technicians),
        llm_calls_total=journal.count_llm_calls(session),
        cost_eur_last_24h=round(cost_cap.spent_last_24h(session), 4),
        cost_cap_eur_per_day=settings.cost_cap_eur_per_day,
    )
