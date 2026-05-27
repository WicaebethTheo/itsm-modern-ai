"""Healthcheck (FR-27). Reflète l'état GLPI ET LLM ; échec si GLPI injoignable."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from ..runtime import build_connector, build_llm

router = APIRouter(tags=["health"])


class GlpiHealth(BaseModel):
    configured: bool
    reachable: bool
    version: str | None = None  # version du serveur GLPI (ex. « 10.0.18 »), si connue


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

    # Version GLPI (best-effort) — mise en cache par base_url pour éviter un appel
    # `getGlpiConfig` à chaque sonde (/health est appelé fréquemment par l'UI/le proxy).
    glpi_version = None
    if connector is not None and glpi_reachable:
        glpi_version = await _glpi_version(request, connector)

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
        glpi=GlpiHealth(configured=glpi_configured, reachable=glpi_reachable, version=glpi_version),
        llm=LlmHealth(configured=llm_configured, reachable=llm_reachable),
    )


async def _glpi_version(request: Request, connector) -> str | None:
    """Version GLPI avec cache (base_url → version) sur app.state. Refetch si l'URL change."""
    cache = getattr(request.app.state, "glpi_version_cache", None)
    if cache is not None and cache.get("base_url") == connector.base_url:
        return cache.get("version")
    version = await connector.server_version()
    request.app.state.glpi_version_cache = {"base_url": connector.base_url, "version": version}
    return version
