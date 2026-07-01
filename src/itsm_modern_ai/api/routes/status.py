"""Statut runtime du moteur (FR-27, observabilité minimale) + compteurs (FR-10).

Endpoint PUBLIC (l'installeur sonde `GET /api/status` et attend un 200 sans auth) mais à
réponse À DEUX NIVEAUX (durcissement audit 2026-06) : sans session admin, seul l'état de
marche est exposé (ok, version, polling) ; compteurs LLM, coût 24 h, plafond et volumétrie
des référentiels ne sont renvoyés QUE si la requête est authentifiée — sinon n'importe qui
sur le réseau lirait la consommation et la volumétrie de l'instance.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from ...persistence import journal
from ...services import cost_cap
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_session
from ..security import session_is_authenticated

router = APIRouter(prefix="/api", tags=["status"])


class Status(BaseModel):
    # Partie publique : strict état de marche.
    ok: bool = True
    version: str
    polling_enabled: bool
    # Partie enrichie (session admin uniquement) : None → champ omis de la réponse.
    polling_interval_seconds: int | None = None
    whitelist_loaded: bool | None = None
    categories_count: int | None = None
    technicians_count: int | None = None
    llm_calls_total: int | None = None
    cost_eur_last_24h: float | None = None
    cost_cap_eur_per_day: float | None = None


@router.get("/status", response_model=Status, response_model_exclude_none=True)
def status(request: Request, session: Session = Depends(get_session)) -> Status:
    from ... import __version__

    settings = request.app.state.settings
    # Valeurs RUNTIME (surcharges UI en base), pas les seules valeurs d'env : sinon une
    # pause du polling depuis la console serait invisible ici (incohérence env vs runtime).
    cfg = RuntimeConfigService(session, request.app.state.secrets_box, settings)
    body = Status(
        version=__version__,
        polling_enabled=cfg.get_bool("polling_enabled", settings.polling_enabled),
    )
    if not session_is_authenticated(request):
        return body  # réponse publique minimale (installeur, sonde réseau)

    cache = request.app.state.whitelist_cache
    refs = cache.referentials
    body.polling_interval_seconds = cfg.get_int(
        "polling_interval_seconds", settings.polling_interval_seconds
    )
    body.whitelist_loaded = cache.is_loaded
    body.categories_count = len(refs.categories)
    body.technicians_count = len(refs.technicians)
    body.llm_calls_total = journal.count_llm_calls(session)
    body.cost_eur_last_24h = round(cost_cap.spent_last_24h(session), 4)
    body.cost_cap_eur_per_day = cfg.get_float("cost_cap_eur_per_day", settings.cost_cap_eur_per_day)
    return body
