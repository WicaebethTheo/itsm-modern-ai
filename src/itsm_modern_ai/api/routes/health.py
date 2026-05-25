"""Healthcheck (FR-27). En échec si GLPI injoignable une fois configuré."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from ..runtime import build_connector

router = APIRouter(tags=["health"])


class GlpiHealth(BaseModel):
    configured: bool
    reachable: bool


class Health(BaseModel):
    status: str  # "ok" | "degraded"
    glpi: GlpiHealth


@router.get("/health", response_model=Health)
async def health(request: Request, response: Response) -> Health:
    settings = request.app.state.settings
    connector = build_connector(settings, request.app.state.secrets_box)
    configured = connector is not None
    reachable = await connector.healthcheck() if connector is not None else False

    # En pilote, GLPI non encore configuré n'est pas un échec dur (clé à pousser via UI).
    ok = (not configured) or reachable
    if not ok:
        response.status_code = 503
    return Health(status="ok" if ok else "degraded", glpi=GlpiHealth(configured=configured, reachable=reachable))
