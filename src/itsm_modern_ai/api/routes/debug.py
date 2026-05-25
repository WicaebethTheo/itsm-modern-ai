"""Outils de DEBUG (labo/test) : diagnostics GLPI + jeux de données + purge.

Gardes-fous : tout est inerte sauf si `DEBUG_TOOLS_ENABLED=true` (flag, défaut False),
ET derrière l'authentification locale. La purge exige une confirmation explicite et fait
un SOFT-delete (corbeille GLPI), en protégeant les comptes système/glpi/token.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ...adapters.itsm.glpi.debug import GlpiDebugOps
from ...domain.errors import ItsmError
from ...persistence import db
from ...services.runtime_config import RuntimeConfigService
from ..runtime import build_connector, build_llm
from ..security import require_auth

router = APIRouter(prefix="/api/debug", tags=["debug"], dependencies=[Depends(require_auth)])


def _enabled(request: Request) -> bool:
    return bool(request.app.state.settings.debug_tools_enabled)


def require_debug(request: Request) -> None:
    if not _enabled(request):
        raise HTTPException(
            status_code=403,
            detail={"code": "debug_disabled", "message": "Outils de debug désactivés (DEBUG_TOOLS_ENABLED)."},
        )


def _creds(request: Request):
    settings = request.app.state.settings
    with db.session_scope() as s:
        return RuntimeConfigService(s, request.app.state.secrets_box, settings).glpi_credentials()


@router.get("/status")
def status(request: Request) -> dict:
    return {"enabled": _enabled(request)}


@router.get("/info", dependencies=[Depends(require_debug)])
def info(request: Request) -> dict:
    """Version du logiciel + endpoints exposés (introspection des routes)."""
    from fastapi.routing import APIRoute

    endpoints = []
    for r in request.app.routes:
        if isinstance(r, APIRoute) and (r.path.startswith("/api") or r.path == "/health"):
            methods = sorted(m for m in r.methods if m not in ("HEAD", "OPTIONS"))
            endpoints.append({"path": r.path, "methods": methods})
    endpoints.sort(key=lambda e: e["path"])
    return {"version": request.app.version, "title": request.app.title, "endpoints": endpoints}


@router.get("/diagnostics", dependencies=[Depends(require_debug)])
async def diagnostics(request: Request) -> dict:
    settings = request.app.state.settings
    secrets = request.app.state.secrets_box
    out: dict = {"glpi": {"configured": False}, "llm": {"configured": False}}

    connector = build_connector(settings, secrets)
    if connector is not None:
        out["glpi"]["configured"] = True
        try:
            out["glpi"]["reachable"] = await connector.healthcheck()
            refs = await connector.get_referentials()
            out["glpi"]["referentials"] = {
                "categories": len(refs.categories),
                "technicians": len(refs.technicians),
                "groups": len(refs.groups),
                "entities": len(refs.entities),
                "profiles": len(refs.technician_profiles),
            }
            out["glpi"]["new_tickets"] = len(await connector.get_new_tickets())
            since = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=14)
            out["glpi"]["recent_tickets_14d"] = len(await connector.get_recent_tickets(since))
        except ItsmError as exc:
            out["glpi"]["error"] = str(exc)

    llm = build_llm(settings, secrets)
    out["llm"]["configured"] = llm is not None
    if llm is not None:
        try:
            out["llm"]["reachable"] = await llm.healthcheck()
        except Exception as exc:  # noqa: BLE001
            out["llm"]["error"] = str(exc)
    return out


class SeedRequest(BaseModel):
    technicians: int = Field(default=3, ge=0, le=50)
    groups: int = Field(default=2, ge=0, le=50)


@router.post("/seed", dependencies=[Depends(require_debug)])
async def seed(body: SeedRequest, request: Request) -> dict:
    creds = _creds(request)
    if not creds.is_configured:
        raise HTTPException(409, {"code": "glpi_not_configured", "message": "Configurer GLPI d'abord."})
    try:
        return await GlpiDebugOps(creds).seed(body.technicians, body.groups)
    except ItsmError as exc:
        raise HTTPException(502, {"code": "glpi_error", "message": str(exc)}) from exc


class PurgeRequest(BaseModel):
    confirm: str  # doit valoir "SUPPRIMER"


@router.post("/purge-users", dependencies=[Depends(require_debug)])
async def purge_users(body: PurgeRequest, request: Request) -> dict:
    if body.confirm != "SUPPRIMER":
        raise HTTPException(
            400, {"code": "confirmation_required", "message": "Saisir SUPPRIMER pour confirmer."}
        )
    creds = _creds(request)
    if not creds.is_configured:
        raise HTTPException(409, {"code": "glpi_not_configured", "message": "Configurer GLPI d'abord."})
    try:
        return await GlpiDebugOps(creds).purge_users()
    except ItsmError as exc:
        raise HTTPException(502, {"code": "glpi_error", "message": str(exc)}) from exc
