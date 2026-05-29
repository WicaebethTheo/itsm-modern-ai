"""Sandbox : triage à blanc d'un texte de Ticket, SANS écrire dans GLPI.

Utile pour le débrief pilote (montrer les Décisions à Sylvain avant Karim, PRD §12)
et pour calibrer. Le LLM doit être configuré (clé poussée via /api/config).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ...persistence import db
from ...services import referentials
from ..runtime import build_triage_service

router = APIRouter(prefix="/api", tags=["sandbox"])


class SandboxRequest(BaseModel):
    title: str = ""
    content: str


class SandboxResponse(BaseModel):
    accepted: bool
    reason: str
    category: int | None = None
    category_name: str | None = None  # libellé GLPI résolu, sinon None → l'UI affiche l'id
    priority: int | None = None
    technician_id: int | None = None
    technician_name: str | None = None  # nom GLPI du technicien routé
    group_id: int | None = None  # routage de repli vers un groupe (si pas de technicien)
    group_name: str | None = None  # nom GLPI du groupe routé
    confidence: float | None = None
    draft: str | None = None


def _name_map(session, kind: str) -> dict[int, str]:
    return {r.ext_id: r.name for r in referentials.list_kind(session, kind)}


@router.post("/sandbox", response_model=SandboxResponse)
async def sandbox(body: SandboxRequest, request: Request) -> SandboxResponse:
    settings = request.app.state.settings
    triage = build_triage_service(settings, request.app.state.secrets_box)
    if triage is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "llm_not_configured", "message": "Clé LLM absente : pousser via POST /api/config."},
        )

    raw = f"{body.title}\n{body.content}".strip()
    # Périmètre EFFECTIF lu depuis la DB (catégories sélectionnées, techniciens/groupes
    # éligibles), comme le moteur réel (cf. app.py:_effective_refs). On NE lit PAS le cache
    # mémoire `whitelist_cache.referentials`, qui n'est peuplé que par le poller : si le
    # polling est off, ce cache serait vide et la sandbox renverrait « à trier » à tort.
    with db.session_scope() as session:
        refs = referentials.effective_referentials(session)
    outcome, _ = await triage.evaluate_text(0, raw, refs)
    d = outcome.decision
    # Résolution des noms via le cache de référentiels (même source que le Journal),
    # pour que l'UI affiche « Adrien Durand » plutôt que « T#9 ».
    with db.session_scope() as session:
        cats = _name_map(session, referentials.KIND_CATEGORY)
        techs = _name_map(session, referentials.KIND_TECHNICIAN)
        groups = _name_map(session, referentials.KIND_GROUP)
    return SandboxResponse(
        accepted=outcome.accepted,
        reason=outcome.reason.value,
        category=d.category if d else None,
        category_name=cats.get(d.category) if d and d.category is not None else None,
        priority=d.priority if d else None,
        technician_id=d.technician_id if d else None,
        technician_name=techs.get(d.technician_id) if d and d.technician_id is not None else None,
        group_id=d.group_id if d else None,
        group_name=groups.get(d.group_id) if d and d.group_id is not None else None,
        confidence=d.confidence if d else None,
        draft=d.draft if d else None,
    )
