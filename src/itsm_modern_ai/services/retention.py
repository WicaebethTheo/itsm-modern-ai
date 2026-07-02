"""Rétention RGPD : purge périodique du Journal et des appels LLM.

Pure orchestration (sans I/O réseau) : on calcule les bornes temporelles, on délègue
la suppression à `persistence.journal`, puis on consigne la dernière exécution dans
`RuntimeConfig` (UI). `*_days <= 0` désactive la purge pour la table concernée — défaut
sûr : on ne supprime que sur demande explicite (jamais d'effet de bord silencieux).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from pydantic import BaseModel
from sqlmodel import Session

from ..persistence import journal
from .runtime_config import RuntimeConfigService


class PurgeResult(BaseModel):
    ran_at: datetime
    decisions_days: int
    llm_calls_days: int
    cutoff_decisions: datetime | None  # None si retention désactivée (days <= 0)
    cutoff_llm_calls: datetime | None
    decisions_deleted: int
    llm_calls_deleted: int


def purge_now(
    session: Session,
    *,
    decisions_days: int,
    llm_calls_days: int,
    now: datetime | None = None,
) -> PurgeResult:
    """Purge les lignes plus vieilles que les fenêtres données. Sans effet si days <= 0.

    `now` paramétrable pour faciliter les tests (sinon UTC courant).
    """
    ran_at = now or datetime.now(UTC)
    cutoff_dec = ran_at - timedelta(days=decisions_days) if decisions_days > 0 else None
    cutoff_llm = ran_at - timedelta(days=llm_calls_days) if llm_calls_days > 0 else None

    deleted_dec = journal.purge_decisions_before(session, cutoff_dec) if cutoff_dec else 0
    deleted_llm = journal.purge_llm_calls_before(session, cutoff_llm) if cutoff_llm else 0

    return PurgeResult(
        ran_at=ran_at,
        decisions_days=decisions_days,
        llm_calls_days=llm_calls_days,
        cutoff_decisions=cutoff_dec,
        cutoff_llm_calls=cutoff_llm,
        decisions_deleted=deleted_dec,
        llm_calls_deleted=deleted_llm,
    )


def record_last_run(cfg: RuntimeConfigService, result: PurgeResult, *, by: str) -> None:
    """Persiste l'état de la dernière purge dans RuntimeConfig (consulté par l'UI).

    `by` est l'identifiant de l'initiateur (audit trail RGPD) : "scheduler" pour le job
    automatique, sinon l'IP/session de l'admin qui a déclenché manuellement.
    """
    cfg.set("automation_purge_last_run_at", result.ran_at.isoformat())
    cfg.set("automation_purge_last_decisions_deleted", str(result.decisions_deleted))
    cfg.set("automation_purge_last_llm_calls_deleted", str(result.llm_calls_deleted))
    cfg.set("automation_purge_last_run_by", by)
