"""Sandbox : triage à blanc d'un texte de Ticket, SANS écrire dans GLPI.

Utile pour le débrief pilote (montrer les Décisions à Sylvain avant Karim, PRD §12)
et pour calibrer. Le LLM doit être configuré (clé poussée via /api/config).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ...domain import masking
from ...persistence import db, journal
from ...services import cost_cap, referentials
from ...services.runtime_config import RuntimeConfigService
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
    secrets = request.app.state.secrets_box
    triage = build_triage_service(settings, secrets)
    if triage is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "llm_not_configured", "message": "Clé LLM absente : pousser via POST /api/config."},
        )

    raw = f"{body.title}\n{body.content}".strip()
    # Cost cap (FR-10) AVANT l'appel facturant, comme le moteur réel : la sandbox
    # contournait le plafond ET n'apparaissait pas dans le journal LLM (dépense fantôme).
    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, secrets, settings)
        cap = cfg.get_float("cost_cap_eur_per_day", settings.cost_cap_eur_per_day)
        price_in = cfg.get_float("llm_price_input_per_mtok", settings.llm_price_input_per_mtok)
        price_out = cfg.get_float("llm_price_output_per_mtok", settings.llm_price_output_per_mtok)
        if cost_cap.is_over_cap(session, cap):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "cost_cap_reached",
                    "message": "Plafond de coût LLM quotidien atteint : sandbox indisponible.",
                },
            )
        # Périmètre EFFECTIF lu depuis la DB (catégories sélectionnées, techniciens/groupes
        # éligibles), comme le moteur réel (cf. app.py:_effective_refs). On NE lit PAS le cache
        # mémoire `whitelist_cache.referentials`, qui n'est peuplé que par le poller : si le
        # polling est off, ce cache serait vide et la sandbox renverrait « à trier » à tort.
        refs = referentials.effective_referentials(session)
    outcome, result = await triage.evaluate_text(0, raw, refs)
    # Journalise l'appel LLM (FR-19) même en sandbox → visible dans /api/cost et compté
    # dans le cost cap. ticket_id=0 marque une décision hors-ticket (sandbox). Le prompt
    # journalisé est masqué (jamais de PII au repos).
    if result is not None:
        with db.session_scope() as session:
            journal.record_llm_call(
                session,
                ticket_id=0,
                model=result.model,
                prompt_sent=masking.mask(raw).text,
                response_received=result.raw_response,
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
                cost_eur=cost_cap.cost_eur(
                    result.prompt_tokens, result.completion_tokens, price_in, price_out
                ),
            )
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
