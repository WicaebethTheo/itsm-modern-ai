"""Coûts & quotas LLM (FR-10) — plafond journalier glissant + dépense observée.

Le plafond `cost_cap_eur_per_day` (réglable via l'UI) coupe les appels facturants au-delà
(les tickets passent « à trier »). Cette vue expose la dépense des dernières 24 h, le ratio
au plafond, le nombre d'appels et les tarifs configurés. Protégé par l'auth locale (FR-24).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ...persistence import db, journal
from ...services import cost_cap
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service
from ..security import require_auth

router = APIRouter(prefix="/api", tags=["cost"], dependencies=[Depends(require_auth)])


class CostView(BaseModel):
    cost_cap_eur_per_day: float  # 0 = pas de plafond
    spent_eur_last_24h: float
    pct_of_cap: float | None  # null si pas de plafond
    over_cap: bool
    llm_calls_total: int
    price_input_per_mtok: float
    price_output_per_mtok: float
    currency: str = "EUR"


@router.get("/cost", response_model=CostView)
def cost(request: Request, cfg: RuntimeConfigService = Depends(get_config_service)) -> CostView:
    s = cfg.settings
    cap = cfg.get_float("cost_cap_eur_per_day", s.cost_cap_eur_per_day)
    with db.session_scope() as session:
        spent = round(cost_cap.spent_last_24h(session), 4)
        total = journal.count_llm_calls(session)
    pct = round(spent / cap * 100, 1) if cap > 0 else None
    return CostView(
        cost_cap_eur_per_day=cap,
        spent_eur_last_24h=spent,
        pct_of_cap=pct,
        over_cap=cap > 0 and spent >= cap,
        llm_calls_total=total,
        price_input_per_mtok=s.llm_price_input_per_mtok,
        price_output_per_mtok=s.llm_price_output_per_mtok,
    )
