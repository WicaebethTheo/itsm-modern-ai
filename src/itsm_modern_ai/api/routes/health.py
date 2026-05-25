"""Healthcheck (FR-27). Reflète l'état GLPI ET LLM ; échec si GLPI injoignable."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from ..runtime import build_connector, build_llm

router = APIRouter(tags=["health"])


class GlpiHealth(BaseModel):
    configured: bool
    reachable: bool


class LlmHealth(BaseModel):
    configured: bool
    reachable: bool | None = None  # None = non sondé (sonde sur ?probe=true)


class Health(BaseModel):
    status: str  # "ok" | "degraded"
    glpi: GlpiHealth
    llm: LlmHealth


@router.get("/health", response_model=Health)
async def health(request: Request, response: Response, probe: bool = False) -> Health:
    settings = request.app.state.settings
    secrets = request.app.state.secrets_box

    connector = build_connector(settings, secrets)
    glpi_configured = connector is not None
    glpi_reachable = await connector.healthcheck() if connector is not None else False

    llm = build_llm(settings, secrets)
    llm_configured = llm is not None
    # Sonde LLM uniquement sur demande (évite coût/latence sur le healthcheck du proxy).
    llm_reachable = (await llm.healthcheck()) if (probe and llm is not None) else None

    # GLPI non configuré n'est pas un échec dur en pilote (secrets à pousser via l'UI).
    ok = (not glpi_configured) or glpi_reachable
    if probe and llm_configured and llm_reachable is False:
        ok = False
    if not ok:
        response.status_code = 503
    return Health(
        status="ok" if ok else "degraded",
        glpi=GlpiHealth(configured=glpi_configured, reachable=glpi_reachable),
        llm=LlmHealth(configured=llm_configured, reachable=llm_reachable),
    )
