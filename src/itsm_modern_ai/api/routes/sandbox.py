"""Sandbox : triage à blanc d'un texte de Ticket, SANS écrire dans GLPI.

Utile pour le débrief pilote (montrer les Décisions à Sylvain avant Karim, PRD §12)
et pour calibrer. Le LLM doit être configuré (clé poussée via /api/config).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..runtime import build_triage_service

router = APIRouter(prefix="/api", tags=["sandbox"])


class SandboxRequest(BaseModel):
    title: str = ""
    content: str


class SandboxResponse(BaseModel):
    accepted: bool
    reason: str
    category: int | None = None
    priority: int | None = None
    technician_id: int | None = None
    confidence: float | None = None
    draft: str | None = None


@router.post("/sandbox", response_model=SandboxResponse)
async def sandbox(body: SandboxRequest, request: Request) -> SandboxResponse:
    settings = request.app.state.settings
    triage = build_triage_service(settings, request.app.state.secrets_box)
    if triage is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "llm_not_configured", "message": "Clé LLM absente : pousser via POST /api/config."},
        )

    refs = request.app.state.whitelist_cache.referentials
    raw = f"{body.title}\n{body.content}".strip()
    outcome, _ = await triage.evaluate_text(0, raw, refs)
    d = outcome.decision
    return SandboxResponse(
        accepted=outcome.accepted,
        reason=outcome.reason.value,
        category=d.category if d else None,
        priority=d.priority if d else None,
        technician_id=d.technician_id if d else None,
        confidence=d.confidence if d else None,
        draft=d.draft if d else None,
    )
