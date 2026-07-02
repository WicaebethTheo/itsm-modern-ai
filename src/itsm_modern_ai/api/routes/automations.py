"""Automatisations planifiées — rétention RGPD du Journal et des appels LLM.

Vitrine d'extension (rapport hebdo, alertes anomalies, re-sync GLPI) ; aujourd'hui une
seule active : la purge périodique. Job quotidien planifié dans `app.py` ; déclenchement
manuel exposé ici (admin). Protégé par l'auth locale (FR-24).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Literal

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ...persistence import db
from ...services import retention
from ...services.runtime_config import RuntimeConfigService
from ..client_ip import client_ip
from ..deps import get_config_service
from ..security import require_auth

logger = logging.getLogger("itsm.automations")

router = APIRouter(prefix="/api/automations", tags=["automations"], dependencies=[Depends(require_auth)])


class RetentionView(BaseModel):
    enabled: bool
    decisions_days: int
    llm_calls_days: int
    hour_utc: int
    last_run_at: datetime | None = None
    last_decisions_deleted: int | None = None
    last_llm_calls_deleted: int | None = None
    last_run_by: str | None = None  # audit RGPD : "scheduler" ou IP de l'admin


class RetentionUpdate(BaseModel):
    """Tous optionnels ; seuls les champs fournis sont mis à jour."""

    enabled: bool | None = None
    decisions_days: int | None = Field(default=None, ge=0, le=3650)
    llm_calls_days: int | None = Field(default=None, ge=0, le=3650)
    hour_utc: int | None = Field(default=None, ge=0, le=23)


def _read_view(cfg: RuntimeConfigService) -> RetentionView:
    s = cfg.settings
    last_at = cfg.get("automation_purge_last_run_at")
    last_dec = cfg.get("automation_purge_last_decisions_deleted")
    last_llm = cfg.get("automation_purge_last_llm_calls_deleted")
    return RetentionView(
        enabled=cfg.get_bool("automation_purge_enabled", s.automation_purge_enabled),
        decisions_days=cfg.get_int("retention_decisions_days", s.retention_decisions_days),
        llm_calls_days=cfg.get_int("retention_llm_calls_days", s.retention_llm_calls_days),
        hour_utc=cfg.get_int("automation_purge_hour_utc", s.automation_purge_hour_utc),
        last_run_at=datetime.fromisoformat(last_at) if last_at else None,
        last_decisions_deleted=int(last_dec) if last_dec is not None else None,
        last_llm_calls_deleted=int(last_llm) if last_llm is not None else None,
        last_run_by=cfg.get("automation_purge_last_run_by"),
    )


@router.get("/retention", response_model=RetentionView)
def get_retention(cfg: RuntimeConfigService = Depends(get_config_service)) -> RetentionView:
    return _read_view(cfg)


@router.patch("/retention", response_model=RetentionView)
def update_retention(
    body: RetentionUpdate,
    request: Request,
    cfg: RuntimeConfigService = Depends(get_config_service),
) -> RetentionView:
    data = body.model_dump(exclude_none=True)
    if "enabled" in data:
        cfg.set("automation_purge_enabled", str(data["enabled"]).lower())
    if "decisions_days" in data:
        cfg.set("retention_decisions_days", str(data["decisions_days"]))
    if "llm_calls_days" in data:
        cfg.set("retention_llm_calls_days", str(data["llm_calls_days"]))
    if "hour_utc" in data:
        cfg.set("automation_purge_hour_utc", str(data["hour_utc"]))
        # Re-planifie à chaud le job de purge (pinné UTC pour rester cohérent avec app.py).
        scheduler = getattr(request.app.state, "scheduler", None)
        if scheduler is not None and scheduler.get_job("purge") is not None:
            scheduler.reschedule_job(
                "purge",
                trigger=CronTrigger(hour=int(data["hour_utc"]), minute=0, timezone=UTC),
            )
    return _read_view(cfg)


class PurgeRunBody(BaseModel):
    """Garde-fou de confirmation explicite : aligné sur `/api/debug/purge-users` (action destructive)."""

    confirm: Literal["PURGER"]


class PurgeRunResult(BaseModel):
    decisions_deleted: int
    llm_calls_deleted: int
    ran_at: datetime
    view: RetentionView


@router.post("/retention/run", response_model=PurgeRunResult)
def run_retention(
    body: PurgeRunBody,
    request: Request,
    cfg: RuntimeConfigService = Depends(get_config_service),
) -> PurgeRunResult:
    """Déclenchement manuel (admin) : exécute la purge MAINTENANT, indépendamment de l'enable.

    Exige `confirm="PURGER"` (anti-CSRF + anti-clic-malheureux) et trace l'initiateur
    (IP) dans le journal applicatif + `automation_purge_last_run_by` (audit RGPD).
    """
    _ = body  # validé par Pydantic ; la présence du champ confirm suffit
    s = cfg.settings
    decisions_days = cfg.get_int("retention_decisions_days", s.retention_decisions_days)
    llm_days = cfg.get_int("retention_llm_calls_days", s.retention_llm_calls_days)
    trust = bool(getattr(request.app.state.settings, "trust_proxy_headers", False))
    hops = int(getattr(request.app.state.settings, "trusted_proxy_hops", 1))
    initiator = client_ip(request, trust, trusted_hops=hops)
    with db.session_scope() as session:
        result = retention.purge_now(
            session, decisions_days=decisions_days, llm_calls_days=llm_days
        )
    retention.record_last_run(cfg, result, by=initiator)
    logger.warning(
        "purge MANUELLE déclenchée par %s : %d décision(s), %d appel(s) LLM (fenêtres %dj/%dj)",
        initiator, result.decisions_deleted, result.llm_calls_deleted, decisions_days, llm_days,
    )
    return PurgeRunResult(
        decisions_deleted=result.decisions_deleted,
        llm_calls_deleted=result.llm_calls_deleted,
        ran_at=result.ran_at,
        view=_read_view(cfg),
    )
