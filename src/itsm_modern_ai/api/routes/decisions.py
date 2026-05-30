"""Journal de décision (FR-20) : consultation triable + annotation manuelle."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ...persistence import journal
from ...persistence.journal import DEFAULT_DECISIONS_LIMIT
from ...persistence.tables import DecisionLog
from ...services import referentials
from ...services.links import ticket_web_link
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service, get_session
from ..security import require_auth

router = APIRouter(prefix="/api", tags=["journal"], dependencies=[Depends(require_auth)])


class DecisionEntry(BaseModel):
    id: int
    ticket_id: int
    ts: datetime
    subject: str
    accepted: bool
    reason: str
    category: int | None
    category_name: str | None = None  # libellé GLPI résolu (sinon None → l'UI affiche l'id)
    priority: int | None
    urgency: int | None = None  # urgence appliquée = min(priority, 5) ; None si pas de priorité
    technician_id: int | None
    technician_name: str | None = None  # nom GLPI du technicien routé (résolu)
    group_id: int | None
    group_name: str | None = None  # nom GLPI du groupe routé (résolu)
    confidence: float | None
    glpi_link: str
    annotation: str
    mode: str = ""  # mode d'exécution résolu (suggestion | semi_auto | full_auto)
    applied: bool = False  # True si la Décision a muté les champs du Ticket GLPI


class AnnotationUpdate(BaseModel):
    annotation: str


def _name_map(session: Session, kind: str) -> dict[int, str]:
    return {r.ext_id: r.name for r in referentials.list_kind(session, kind)}


def _to_entry(
    row: DecisionLog,
    cats: dict[int, str],
    techs: dict[int, str],
    groups: dict[int, str],
    glpi_base_url: str = "",
) -> DecisionEntry:
    """Enrichit une décision brute : noms résolus (cat/tech/groupe) + urgence dérivée.

    Le lien GLPI est reconstruit à la lecture depuis l'URL GLPI **courante** (config
    runtime, posée via l'UI) : il reflète toujours l'instance configurée et reste valide
    même pour les décisions enregistrées avant que GLPI ne soit configuré (où le lien figé
    valait ""). Repli sur le lien stocké si l'URL runtime est absente.
    """
    glpi_link = ticket_web_link(glpi_base_url, row.ticket_id) or row.glpi_link
    return DecisionEntry(
        id=row.id,
        ticket_id=row.ticket_id,
        ts=row.ts,
        subject=row.subject,
        accepted=row.accepted,
        reason=row.reason,
        category=row.category,
        category_name=cats.get(row.category) if row.category is not None else None,
        priority=row.priority,
        # GLPI : urgence ∈ 1..5 (MAJEURE 6 → 5), comme à l'application (cf. mapper).
        urgency=min(row.priority, 5) if row.priority is not None else None,
        technician_id=row.technician_id,
        technician_name=techs.get(row.technician_id) if row.technician_id is not None else None,
        group_id=row.group_id,
        group_name=groups.get(row.group_id) if row.group_id is not None else None,
        confidence=row.confidence,
        glpi_link=glpi_link,
        annotation=row.annotation,
        mode=row.mode,
        applied=row.applied,
    )


@router.get("/decisions", response_model=list[DecisionEntry])
def list_decisions(
    limit: int = DEFAULT_DECISIONS_LIMIT,
    session: Session = Depends(get_session),
    cfg: RuntimeConfigService = Depends(get_config_service),
) -> list[DecisionEntry]:
    cats = _name_map(session, referentials.KIND_CATEGORY)
    techs = _name_map(session, referentials.KIND_TECHNICIAN)
    groups = _name_map(session, referentials.KIND_GROUP)
    glpi_base_url = cfg.active_glpi_base_url()
    return [
        _to_entry(d, cats, techs, groups, glpi_base_url)
        for d in journal.list_decisions(session, limit=limit)
    ]


@router.patch("/decisions/{decision_id}/annotation", response_model=DecisionEntry)
def annotate(
    decision_id: int,
    body: AnnotationUpdate,
    session: Session = Depends(get_session),
    cfg: RuntimeConfigService = Depends(get_config_service),
) -> DecisionEntry:
    row = journal.set_annotation(session, decision_id, body.annotation)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Décision introuvable."})
    cats = _name_map(session, referentials.KIND_CATEGORY)
    techs = _name_map(session, referentials.KIND_TECHNICIAN)
    groups = _name_map(session, referentials.KIND_GROUP)
    glpi_base_url = cfg.active_glpi_base_url()
    return _to_entry(row, cats, techs, groups, glpi_base_url)
