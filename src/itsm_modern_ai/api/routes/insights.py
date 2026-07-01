"""Endpoints JSON pour l'UI : métriques Journal + Dashboard inversé GLPI (FR-23)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from ...domain.errors import ItsmError
from ...persistence import journal
from ...services import cost_cap, dashboard
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_session
from ..runtime import build_connector
from ..security import require_auth

router = APIRouter(prefix="/api", tags=["insights"], dependencies=[Depends(require_auth)])


class DayPoint(BaseModel):
    date: str
    accepted: int
    a_trier: int


class Metrics(BaseModel):
    total: int
    accepted: int
    a_trier: int
    useful_coverage: float
    by_reason: dict[str, int]
    llm_calls: int
    cost_eur_last_24h: float
    cost_cap_eur_per_day: float
    avg_confidence: float | None = None
    series: list[DayPoint] = []


@router.get("/metrics", response_model=Metrics)
def metrics(request: Request, session: Session = Depends(get_session)) -> Metrics:
    """Métriques du Journal (volume, couverture utile, coût, confiance, série 14 j) — niveau équipe."""
    stats = journal.decision_stats(session)
    settings = request.app.state.settings
    # Plafond RUNTIME (réglable via l'UI) : le moteur lit cette valeur (api/runtime.py) —
    # afficher la seule valeur d'env induirait l'admin en erreur après un réglage à chaud.
    cfg = RuntimeConfigService(session, request.app.state.secrets_box, settings)
    return Metrics(
        **stats,
        llm_calls=journal.count_llm_calls(session),
        cost_eur_last_24h=round(cost_cap.spent_last_24h(session), 4),
        cost_cap_eur_per_day=cfg.get_float("cost_cap_eur_per_day", settings.cost_cap_eur_per_day),
        avg_confidence=journal.avg_confidence(session),
        series=[DayPoint(**d) for d in journal.daily_series(session, days=14)],
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
    secrets = request.app.state.secrets_box
    connector = build_connector(settings, secrets)
    if connector is None:
        return OperationalView(available=False, detail="GLPI non configuré.")

    # Fenêtre / seuil d'anomalie configurables au runtime (UI).
    from ...persistence import db
    from ...services import referentials
    from ...services.runtime_config import RuntimeConfigService

    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, secrets, settings)
        window_days = cfg.get_int("dashboard_window_days", settings.dashboard_window_days)
        new_age_hours = cfg.get_int("anomaly_new_age_hours", settings.anomaly_new_age_hours)
        scope = referentials.effective_referentials(session).entities

    now = datetime.now(UTC).replace(tzinfo=None)  # dates GLPI naïves
    since = now - timedelta(days=window_days)
    try:
        stats = await connector.get_recent_tickets(since)
    except ItsmError as exc:
        return OperationalView(available=False, detail=f"Lecture GLPI impossible : {exc}")

    # Restreint au périmètre d'entités sélectionné (cohérent avec le polling, Story 5.4).
    if scope:
        stats = [s for s in stats if s.entity_id in scope]

    return OperationalView(
        available=True,
        metrics=dashboard.compute(
            stats,
            window_days=window_days,
            now=now,
            new_age_hours=new_age_hours,
            glpi_base_url=connector.base_url,
        ),
    )
