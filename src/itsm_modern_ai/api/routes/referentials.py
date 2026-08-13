"""Référentiels GLPI : scan, découverte, et sélection du périmètre par l'admin.

Pattern (réécrit pour la prod) : on SCANNE GLPI (techniciens, groupes, entités,
catégories), puis l'admin SÉLECTIONNE dans la console ce que l'IA a le droit
d'utiliser — catégories/entités du périmètre, techniciens/groupes éligibles + fiches.
"""

from __future__ import annotations

from datetime import datetime

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
    # Cible de repli (entités) : acteur assigné quand le garde-fou refuse une Décision.
    fallback_group_id: int | None = None
    fallback_technician_id: int | None = None
    # Date du DERNIER SCAN GLPI qui a vu cet objet. Exposée parce que la console n'avait
    # aucun moyen de dire de quand datait le cache : un technicien parti il y a trois mois
    # restait proposé au routage sans que rien ne signale que la liste était périmée.
    # Côté serveur uniquement — un repli `localStorage` mentirait sur une console partagée
    # (chaque navigateur aurait « sa » date de dernière synchro).
    updated_at: datetime | None = None


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
    # Cible de REPLI pour cette entité. Groupe prioritaire sur technicien (cf. `set_modes`).
    fallback_group_id: int | None = None
    fallback_technician_id: int | None = None


def _item(row) -> RefItem:
    return RefItem(
        ext_id=row.ext_id, name=row.name, profile=row.profile, selected=row.selected,
        eligible=row.eligible, skills=row.skills,
        skill_tags=[k for k in (getattr(row, "skill_tags", "") or "").split(",") if k],
        mode=getattr(row, "mode", None), auto_min_confidence=getattr(row, "auto_min_confidence", None),
        fallback_group_id=getattr(row, "fallback_group_id", None),
        fallback_technician_id=getattr(row, "fallback_technician_id", None),
        updated_at=getattr(row, "updated_at", None),
    )


@router.post("/glpi/sync", response_model=SyncResult)
async def sync_glpi(request: Request, session: Session = Depends(get_session)) -> SyncResult:
    """Scanne GLPI et met à jour le cache local (préserve les sélections existantes).

    L'horodatage du scan est posé par `referentials.sync`, ligne par ligne et seulement
    sur les objets RÉELLEMENT vus (cf. sa docstring) : un objet disparu de GLPI est
    conservé, mais il garde la date du dernier scan qui l'a vu.

    Un scan qui ne rapporte AUCUN objet alors que le cache en contient déjà n'est pas un
    succès : GLPI répond 200 avec des listes vides quand le compte technique a perdu ses
    droits, quand l'entité active est la mauvaise ou quand le profil est restreint. Le
    signaler `ok=True` afficherait un scan vert sur un périmètre que GLPI vient de
    désavouer — et rajeunirait un cache que plus rien ne confirme. On refuse donc, sans
    rien supprimer : le cache reste exploitable, il cesse juste d'être certifié frais.
    """
    connector = build_connector(request.app.state.settings, request.app.state.secrets_box)
    if connector is None:
        raise HTTPException(409, {"code": "glpi_not_configured", "message": "Configurer GLPI d'abord."})
    try:
        refs = await connector.get_referentials()
    except Exception as exc:  # noqa: BLE001 — surface en message clair
        return SyncResult(ok=False, detail=f"Échec du scan GLPI : {exc}")
    deja_en_cache = referentials.cache_size(session)
    counts = referentials.sync(session, refs)
    if sum(counts.values()) == 0 and deja_en_cache:
        return SyncResult(
            ok=False,
            detail=(
                f"GLPI n'a renvoyé aucun objet alors que le cache en contient "
                f"{deja_en_cache} : vérifiez les droits du compte technique et son entité "
                "active. Le cache est conservé tel quel, sans être marqué frais."
            ),
            counts=counts,
        )
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
    _reject_ineligible_fallbacks(session, body)
    entites = referentials.list_kind(session, referentials.KIND_ENTITY)
    avant = {
        r.ext_id: (r.mode, r.auto_min_confidence, r.fallback_group_id, r.fallback_technician_id)
        for r in entites
    }
    referentials.set_modes(session, [b.model_dump() for b in body])
    apres = [_item(r) for r in referentials.list_kind(session, referentials.KIND_ENTITY)]

    # Une entrée par entité RÉELLEMENT modifiée : réécrire la liste entière sans rien
    # changer ne doit pas noyer le journal (l'UI renvoie toujours toutes les entités).
    for r in referentials.list_kind(session, referentials.KIND_ENTITY):
        ancien = avant.get(r.ext_id)
        nouveau = (r.mode, r.auto_min_confidence, r.fallback_group_id, r.fallback_technician_id)
        if ancien is not None and ancien != nouveau:
            cfg.record_action(
                "entity_mode",
                f"entity:{r.ext_id}",
                _mode_repr(*ancien),
                _mode_repr(*nouveau),
            )
    return apres


def _reject_ineligible_fallbacks(session: Session, body: list[ModeItem]) -> None:
    """Refuse une cible de repli hors périmètre — À L'ENREGISTREMENT, avec un message clair.

    Accepter silencieusement produirait une configuration INOPÉRANTE : le moteur revalide la
    cible au moment d'écrire (`fallback_for_entity`) et n'assignerait donc rien, sans que
    l'admin comprenne pourquoi son repli ne fonctionne pas. Mieux vaut refuser tout de suite
    que promettre un filet qui n'existe pas.
    """
    eligibles = {
        "group": {r.ext_id for r in referentials.list_kind(session, referentials.KIND_GROUP) if r.eligible},
        "technician": {
            r.ext_id for r in referentials.list_kind(session, referentials.KIND_TECHNICIAN) if r.eligible
        },
    }
    for item in body:
        for kind, ext_id in (
            ("group", item.fallback_group_id),
            ("technician", item.fallback_technician_id),
        ):
            if ext_id is not None and ext_id not in eligibles[kind]:
                raise HTTPException(
                    400,
                    {
                        "code": "fallback_not_eligible",
                        "message": (
                            f"Cible de repli hors périmètre ({kind} #{ext_id}) : rendez-la "
                            "éligible d'abord, sinon le repli resterait sans effet."
                        ),
                    },
                )


def _mode_repr(
    mode: str | None, seuil: float | None, repli_groupe: int | None = None,
    repli_tech: int | None = None,
) -> str:
    """Représentation lisible d'un mode d'entité pour le journal d'audit.

    La cible de repli y figure : elle autorise le moteur à assigner un acteur sur un Ticket
    refusé, donc à muter GLPI — c'est une décision de gouvernance, elle doit être imputable
    au même titre que le mode.
    """
    repr_ = f"{mode or 'défaut global'}" + (f" (seuil auto {seuil})" if seuil is not None else "")
    if repli_groupe is not None:
        repr_ += f" [repli groupe #{repli_groupe}]"
    elif repli_tech is not None:
        repr_ += f" [repli technicien #{repli_tech}]"
    return repr_
