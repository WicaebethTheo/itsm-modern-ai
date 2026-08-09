"""Référentiels GLPI : scan, découverte, et sélection du périmètre par l'admin.

Pattern (réécrit pour la prod) : on SCANNE GLPI (techniciens, groupes, entités,
catégories), puis l'admin SÉLECTIONNE dans la console ce que l'IA a le droit
d'utiliser — catégories/entités du périmètre, techniciens/groupes éligibles + fiches.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import Session

from ...domain import skills as domain_skills
from ...services import referentials
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service, get_session
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
    skill_tags: list[str] = Field(default_factory=list)  # domaines cochés (cf. domain.skills)
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
    # `None` = champ NON fourni → les cases déjà cochées côté serveur sont préservées.
    # Un client plus ancien ne doit pas effacer une sélection qu'il ignore.
    skill_tags: list[str] | None = Field(default=None, max_length=64)


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
        skill_tags=[k for k in (getattr(row, "skill_tags", "") or "").split(",") if k],
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


class SkillDomainView(BaseModel):
    key: str
    label_fr: str
    label_en: str
    hint_fr: str


@router.get("/skills", response_model=list[SkillDomainView])
def skill_catalog() -> list[SkillDomainView]:
    """Catalogue des domaines de compétence cochables (contenu produit, pas de la config).

    Exposé par l'API pour que la console n'ait pas à le dupliquer : une divergence entre
    les deux listes ferait cocher des clés que le moteur ignorerait ensuite en silence.
    """
    return [SkillDomainView(**vars(d)) for d in domain_skills.SKILL_CATALOG]


class SkillCoverageView(BaseModel):
    key: str
    label_fr: str
    label_en: str
    technicians: int  # techniciens ÉLIGIBLES ayant coché ce domaine
    groups: int  # groupes ÉLIGIBLES ayant coché ce domaine


@router.get("/skills/coverage", response_model=list[SkillCoverageView])
def skill_coverage(session: Session = Depends(get_session)) -> list[SkillCoverageView]:
    """Carte de couverture des domaines : où le routage va casser, AVANT qu'il casse.

    Un domaine à 0 acteur garantit un « à trier » dès qu'un ticket en relève ; un domaine
    tenu par un seul technicien (et aucun groupe) tombe le jour de son congé. La console
    en fait un bandeau de diagnostic au-dessus de la liste — même écran que celui où l'on
    coche, pour que la panne se corrige là où elle se voit.

    Cardinalités seulement : aucun acteur n'est nommé (anti-mouchard, FR-18/21).
    """
    coverage = referentials.skill_coverage(session)
    return [
        SkillCoverageView(
            key=d.key, label_fr=d.label_fr, label_en=d.label_en, **coverage[d.key]
        )
        for d in domain_skills.SKILL_CATALOG
    ]


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
def save_modes(
    body: list[ModeItem],
    session: Session = Depends(get_session),
    cfg: RuntimeConfigService = Depends(get_config_service),
) -> list[RefItem]:
    """Règle le mode d'exécution (+ seuil semi-auto) PAR ENTITÉ (FR-17).

    ⚠️ semi_auto/full_auto autorisent la mutation des Tickets GLPI ; mode vide = défaut global.

    AUDITÉ EXPLICITEMENT. Le mode par entité vit dans `referential_cache`, pas dans
    `runtime_config` : il échappe donc au traçage automatique de `RuntimeConfigService.set`.
    Or c'est l'action d'administration la plus lourde de conséquences du produit — elle
    autorise l'IA à muter des Tickets et à répondre PUBLIQUEMENT aux demandeurs. Sans la
    ligne ci-dessous, seul le défaut GLOBAL était imputable, et basculer une entité en
    `full_auto` ne laissait aucune trace.
    """
    entites = referentials.list_kind(session, referentials.KIND_ENTITY)
    avant = {r.ext_id: (r.mode, r.auto_min_confidence) for r in entites}
    referentials.set_modes(session, [b.model_dump() for b in body])
    apres = [_item(r) for r in referentials.list_kind(session, referentials.KIND_ENTITY)]

    # Une entrée par entité RÉELLEMENT modifiée : réécrire la liste entière sans rien
    # changer ne doit pas noyer le journal (l'UI renvoie toujours toutes les entités).
    for r in referentials.list_kind(session, referentials.KIND_ENTITY):
        ancien = avant.get(r.ext_id)
        nouveau = (r.mode, r.auto_min_confidence)
        if ancien is not None and ancien != nouveau:
            cfg.record_action(
                "entity_mode",
                f"entity:{r.ext_id}",
                _mode_repr(*ancien),
                _mode_repr(*nouveau),
            )
    return apres


def _mode_repr(mode: str | None, seuil: float | None) -> str:
    """Représentation lisible d'un mode d'entité pour le journal d'audit."""
    return f"{mode or 'défaut global'}" + (f" (seuil auto {seuil})" if seuil is not None else "")
