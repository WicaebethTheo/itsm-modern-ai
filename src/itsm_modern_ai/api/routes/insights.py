"""Endpoints JSON pour l'UI : métriques Journal + Dashboard inversé GLPI (FR-23)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from ...domain.errors import ItsmError
from ...persistence import journal
from ...services import cost_cap, dashboard
from ..deps import get_session
from ..runtime import build_connector
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
    """Métriques issues du Journal (volume, couverture utile, coût) — niveau équipe."""
    stats = journal.decision_stats(session)
    return Metrics(
        **stats,
        llm_calls=journal.count_llm_calls(session),
        cost_eur_last_24h=round(cost_cap.spent_last_24h(session), 4),
        cost_cap_eur_per_day=request.app.state.settings.cost_cap_eur_per_day,
    )


class OperationalView(BaseModel):
    available: bool
    detail: str = ""
    metrics: dashboard.OperationalMetrics | None = None


@router.get("/operational-metrics", response_model=OperationalView)
async def operational_metrics(request: Request) -> OperationalView:
    """Dashboard inversé (FR-23) : métriques d'équipe sourcées GLPI sur une fenêtre.

    Indisponible si GLPI n'est pas configuré. Restreint au périmètre d'entités sélectionné.
    """
    settings = request.app.state.settings
    connector = build_connector(settings, request.app.state.secrets_box)
    if connector is None:
        return OperationalView(available=False, detail="GLPI non configuré.")

    now = datetime.now(UTC).replace(tzinfo=None)  # dates GLPI naïves
    since = now - timedelta(days=settings.dashboard_window_days)
    try:
        stats = await connector.get_recent_tickets(since)
    except ItsmError as exc:
        return OperationalView(available=False, detail=f"Lecture GLPI impossible : {exc}")

    # Restreint au périmètre d'entités sélectionné (cohérent avec le polling, Story 5.4).
    from ...persistence import db
    from ...services import referentials

    with db.session_scope() as session:
        scope = referentials.effective_referentials(session).entities
    if scope:
        stats = [s for s in stats if s.entity_id in scope]

    return OperationalView(
        available=True,
        metrics=dashboard.compute(
            stats,
            window_days=settings.dashboard_window_days,
            now=now,
            new_age_hours=settings.anomaly_new_age_hours,
        ),
    )
