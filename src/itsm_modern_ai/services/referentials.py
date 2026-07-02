"""Référentiels GLPI scannés + périmètre sélectionné par l'admin.

Flux (repris du pattern validé en alpha, réécrit pour la prod) :
1. SCAN GLPI → cache local (catégories, entités, techniciens, groupes).
2. L'admin SÉLECTIONNE dans la console : catégories/entités du périmètre, et
   techniciens/groupes éligibles (+ leurs fiches en prose).
3. Le moteur n'agit que dans ce périmètre (Whitelist effective, FR-7).
"""

from __future__ import annotations

from sqlmodel import Session, select

from ..domain.models import Referentials
from ..domain.modes import ExecutionMode
from ..persistence.tables import ReferentialCache

KIND_CATEGORY = "category"
KIND_ENTITY = "entity"
KIND_TECHNICIAN = "technician"
KIND_GROUP = "group"
KINDS = (KIND_CATEGORY, KIND_ENTITY, KIND_TECHNICIAN, KIND_GROUP)


def _row(session: Session, kind: str, ext_id: int) -> ReferentialCache | None:
    return session.exec(
        select(ReferentialCache).where(
            ReferentialCache.kind == kind, ReferentialCache.ext_id == ext_id
        )
    ).first()


def sync(session: Session, referentials: Referentials) -> dict[str, int]:
    """Met à jour le cache depuis un scan GLPI, en PRÉSERVANT les sélections existantes.

    Renvoie le nombre d'entrées par type. Les objets disparus de GLPI sont conservés
    (l'admin peut nettoyer manuellement) ; seuls les noms sont rafraîchis.
    """
    mapping = {
        KIND_CATEGORY: referentials.categories,
        KIND_ENTITY: referentials.entities,
        KIND_TECHNICIAN: referentials.technicians,
        KIND_GROUP: referentials.groups,
    }
    profiles = referentials.technician_profiles
    counts: dict[str, int] = {}
    for kind, items in mapping.items():
        for ext_id, name in items.items():
            profile = profiles.get(ext_id, "") if kind == KIND_TECHNICIAN else ""
            row = _row(session, kind, ext_id)
            if row is None:
                session.add(ReferentialCache(kind=kind, ext_id=ext_id, name=name, profile=profile))
            else:
                row.name = name
                if kind == KIND_TECHNICIAN:
                    row.profile = profile
                session.add(row)
        counts[kind] = len(items)
    session.commit()
    return counts


def list_kind(session: Session, kind: str) -> list[ReferentialCache]:
    return list(
        session.exec(
            select(ReferentialCache).where(ReferentialCache.kind == kind).order_by(ReferentialCache.name)
        ).all()
    )


def set_eligibility(session: Session, kind: str, items: list[dict]) -> None:
    """Met à jour `eligible` + `skills` pour des techniciens/groupes (par ext_id)."""
    for it in items:
        row = _row(session, kind, int(it["ext_id"]))
        if row is None:
            continue
        row.eligible = bool(it.get("eligible", False))
        row.skills = str(it.get("skills", "") or "")
        session.add(row)
    session.commit()


def set_scope(session: Session, *, category_ids: list[int], entity_ids: list[int]) -> None:
    """Définit le périmètre : catégories et entités sélectionnées (remplace l'existant)."""
    for kind, selected in ((KIND_CATEGORY, set(category_ids)), (KIND_ENTITY, set(entity_ids))):
        for row in list_kind(session, kind):
            row.selected = row.ext_id in selected
            session.add(row)
    session.commit()


def set_modes(session: Session, items: list[dict]) -> None:
    """Règle le mode d'exécution (+ seuil auto) PAR ENTITÉ (kind='entity').

    `mode` vide/None → l'entité retombe sur le défaut global. Un mode invalide est ignoré.
    """
    valid = {m.value for m in ExecutionMode}
    for it in items:
        row = _row(session, KIND_ENTITY, int(it["ext_id"]))
        if row is None:
            continue
        m = it.get("mode")
        row.mode = m if m in valid else None
        amc = it.get("auto_min_confidence")
        row.auto_min_confidence = float(amc) if amc is not None else None
        session.add(row)
    session.commit()


def mode_for_entity(
    session: Session,
    entity_id: int,
    *,
    default_mode: ExecutionMode,
    default_auto_min_confidence: float,
) -> tuple[ExecutionMode, float]:
    """Résout le mode effectif d'une entité : son réglage explicite, sinon le défaut global."""
    row = _row(session, KIND_ENTITY, entity_id)
    mode = ExecutionMode(row.mode) if row and row.mode else default_mode
    threshold = (
        row.auto_min_confidence
        if row and row.auto_min_confidence is not None
        else default_auto_min_confidence
    )
    return mode, threshold


def effective_referentials(session: Session) -> Referentials:
    """Whitelist EFFECTIVE : seulement le périmètre autorisé (catégories sélectionnées,
    techniciens/groupes éligibles, entités sélectionnées)."""
    cats = {r.ext_id: r.name for r in list_kind(session, KIND_CATEGORY) if r.selected}
    techs = {r.ext_id: r.name for r in list_kind(session, KIND_TECHNICIAN) if r.eligible}
    groups = {r.ext_id: r.name for r in list_kind(session, KIND_GROUP) if r.eligible}
    entities = {r.ext_id: r.name for r in list_kind(session, KIND_ENTITY) if r.selected}
    return Referentials(categories=cats, technicians=techs, groups=groups, entities=entities)


def routing_prose(session: Session) -> str:
    """Prose des techniciens et groupes ÉLIGIBLES (pour le routage, FR-15)."""
    blocks: list[str] = []
    for r in list_kind(session, KIND_TECHNICIAN):
        if r.eligible and r.skills.strip():
            blocks.append(f"Technicien {r.ext_id} ({r.name}) :\n{r.skills.strip()}")
    for r in list_kind(session, KIND_GROUP):
        if r.eligible and r.skills.strip():
            blocks.append(f"Groupe {r.ext_id} ({r.name}) :\n{r.skills.strip()}")
    return "\n\n".join(blocks)
