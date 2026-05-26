"""Référentiels GLPI : scan, découverte, et sélection du périmètre par l'admin.

Pattern (réécrit pour la prod) : on SCANNE GLPI (techniciens, groupes, entités,
catégories), puis l'admin SÉLECTIONNE dans la console ce que l'IA a le droit
d'utiliser — catégories/entités du périmètre, techniciens/groupes éligibles + fiches.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import Session

from ...services import referentials
from ..deps import get_session
from ..runtime import build_connector
from ..security import require_auth

router = APIRouter(prefix="/api", tags=["referentials"], dependencies=[Depends(require_auth)])


class RefItem(BaseModel):
    ext_id: int
    name: str
    profile: str = ""  # profil(s) GLPI (techniciens) — pour tri/filtre
    selected: bool
    eligible: bool
    skills: str
    mode: str | None = None  # mode d'exécution (entités) — None = défaut global
    auto_min_confidence: float | None = None  # 2e seuil semi-auto (entités)


class SyncResult(BaseModel):
    ok: bool
    detail: str
    counts: dict[str, int] = {}


class EligibilityItem(BaseModel):
    ext_id: int
    eligible: bool = False
    skills: str = Field(default="", max_length=20_000)


class Scope(BaseModel):
    category_ids: list[int] = Field(default_factory=list, max_length=10_000)
    entity_ids: list[int] = Field(default_factory=list, max_length=10_000)


class ModeItem(BaseModel):
    ext_id: int
    mode: str | None = Field(default=None, pattern="^(suggestion|semi_auto|full_auto)$")
    auto_min_confidence: float | None = Field(default=None, ge=0.0, le=1.0)


def _item(row) -> RefItem:
    return RefItem(
        ext_id=row.ext_id, name=row.name, profile=row.profile, selected=row.selected,
        eligible=row.eligible, skills=row.skills,
        mode=getattr(row, "mode", None), auto_min_confidence=getattr(row, "auto_min_confidence", None),
    )


@router.post("/glpi/sync", response_model=SyncResult)
async def sync_glpi(request: Request, session: Session = Depends(get_session)) -> SyncResult:
    """Scanne GLPI et met à jour le cache local (préserve les sélections existantes)."""
    connector = build_connector(request.app.state.settings, request.app.state.secrets_box)
    if connector is None:
        raise HTTPException(409, {"code": "glpi_not_configured", "message": "Configurer GLPI d'abord."})
    try:
        refs = await connector.get_referentials()
    except Exception as exc:  # noqa: BLE001 — surface en message clair
        return SyncResult(ok=False, detail=f"Échec du scan GLPI : {exc}")
    counts = referentials.sync(session, refs)
    return SyncResult(ok=True, detail="Référentiels synchronisés.", counts=counts)


@router.get("/discovery/{kind}", response_model=list[RefItem])
def discovery(kind: str, session: Session = Depends(get_session)) -> list[RefItem]:
    if kind not in referentials.KINDS:
        raise HTTPException(404, {"code": "unknown_kind", "message": kind})
    return [_item(r) for r in referentials.list_kind(session, kind)]


@router.put("/technicians", response_model=list[RefItem])
def save_technicians(
    body: list[EligibilityItem], session: Session = Depends(get_session)
) -> list[RefItem]:
    referentials.set_eligibility(session, referentials.KIND_TECHNICIAN, [b.model_dump() for b in body])
    return [_item(r) for r in referentials.list_kind(session, referentials.KIND_TECHNICIAN)]


@router.put("/groups", response_model=list[RefItem])
def save_groups(body: list[EligibilityItem], session: Session = Depends(get_session)) -> list[RefItem]:
    referentials.set_eligibility(session, referentials.KIND_GROUP, [b.model_dump() for b in body])
    return [_item(r) for r in referentials.list_kind(session, referentials.KIND_GROUP)]


@router.get("/scope", response_model=Scope)
def get_scope(session: Session = Depends(get_session)) -> Scope:
    return Scope(
        category_ids=[r.ext_id for r in referentials.list_kind(session, referentials.KIND_CATEGORY) if r.selected],
        entity_ids=[r.ext_id for r in referentials.list_kind(session, referentials.KIND_ENTITY) if r.selected],
    )


@router.put("/scope", response_model=Scope)
def set_scope(body: Scope, session: Session = Depends(get_session)) -> Scope:
    referentials.set_scope(session, category_ids=body.category_ids, entity_ids=body.entity_ids)
    return get_scope(session)


@router.put("/modes", response_model=list[RefItem])
def save_modes(body: list[ModeItem], session: Session = Depends(get_session)) -> list[RefItem]:
    """Règle le mode d'exécution (+ seuil semi-auto) PAR ENTITÉ (FR-17).

    ⚠️ semi_auto/full_auto autorisent la mutation des Tickets GLPI ; mode vide = défaut global.
    """
    referentials.set_modes(session, [b.model_dump() for b in body])
    return [_item(r) for r in referentials.list_kind(session, referentials.KIND_ENTITY)]
