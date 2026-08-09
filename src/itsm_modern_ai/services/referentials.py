"""Référentiels GLPI scannés + périmètre sélectionné par l'admin.

Flux (repris du pattern validé en alpha, réécrit pour la prod) :
1. SCAN GLPI → cache local (catégories, entités, techniciens, groupes).
2. L'admin SÉLECTIONNE dans la console : catégories/entités du périmètre, et
   techniciens/groupes éligibles (+ leurs fiches en prose).
3. Le moteur n'agit que dans ce périmètre (Whitelist effective, FR-7).
"""

from __future__ import annotations

from sqlmodel import Session, select

from ..domain import skills as domain_skills
from ..domain.models import Referentials
from ..domain.modes import ExecutionMode
from ..persistence.tables import ReferentialCache
from . import absences

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
    """Met à jour `eligible`, `skills` (prose) et `skill_tags` (cases) par ext_id.

    `skill_tags` n'est écrit que s'il est FOURNI : un client plus ancien qui n'envoie pas
    le champ ne doit pas effacer des cases cochées côté serveur. Les clés inconnues sont
    filtrées par `skills.normalize` (catalogue versionné avec le code).
    """
    for it in items:
        row = _row(session, kind, int(it["ext_id"]))
        if row is None:
            continue
        row.eligible = bool(it.get("eligible", False))
        row.skills = str(it.get("skills", "") or "")
        # `is not None` et non `in it` : Pydantic sérialise le champ absent à `None`, ce
        # qui rendait « non fourni » indiscernable de « vidé ». Une liste VIDE explicite
        # efface bien la sélection (l'admin a décoché) ; `None` la préserve.
        if it.get("skill_tags") is not None:
            row.skill_tags = ",".join(domain_skills.normalize(it.get("skill_tags")))
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
        # Cible de repli : au plus UNE des deux. Un technicien explicite efface le groupe
        # (et réciproquement) — deux cibles simultanées rendraient l'aiguillage ambigu.
        grp = it.get("fallback_group_id")
        tech = it.get("fallback_technician_id")
        row.fallback_group_id = int(grp) if grp is not None else None
        row.fallback_technician_id = int(tech) if tech is not None and grp is None else None
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


def fallback_for_entity(
    session: Session, entity_id: int, refs: Referentials
) -> tuple[int | None, int | None]:
    """Cible de repli RÉELLEMENT applicable pour une entité : `(technicien, groupe)`.

    Validée contre le périmètre AU MOMENT DE L'ÉCRITURE, pas à l'enregistrement. La cible a
    été choisie par l'admin, donc elle était légitime — mais rien ne garantit qu'elle le soit
    encore six mois plus tard (technicien parti, groupe décoché, absence en cours). Sans ce
    contrôle, le repli deviendrait le SEUL chemin par lequel un acteur non validé reçoit un
    Ticket : un contournement de FR-7 par la porte de service.

    Groupe PRÉFÉRÉ : il encaisse une absence sans configuration, là où un technicien nommé
    comme filet de toute l'instance est un point de défaillance unique.
    """
    row = _row(session, KIND_ENTITY, entity_id)
    if row is None:
        return None, None
    if row.fallback_group_id is not None and row.fallback_group_id in refs.groups:
        return None, row.fallback_group_id
    if row.fallback_technician_id is not None and row.fallback_technician_id in refs.technicians:
        return row.fallback_technician_id, None
    return None, None


def effective_referentials(session: Session, *, tz_name: str | None = None) -> Referentials:
    """Whitelist EFFECTIVE : le périmètre autorisé, MOINS les techniciens absents ce jour.

    Le filtre d'absence est appliqué ICI plutôt que chez l'appelant, à dessein : un nouveau
    point d'appel réintroduirait sinon en silence des techniciens en congé dans la whitelist,
    et personne ne s'en apercevrait avant qu'un ticket leur soit assigné pendant leurs
    vacances. Un absent n'est donc jamais proposé — donc jamais assigné (cf. `absences`).
    """
    absents = absences.absent_ext_ids(session, absences.today_local(tz_name))
    cats = {r.ext_id: r.name for r in list_kind(session, KIND_CATEGORY) if r.selected}
    techs = {
        r.ext_id: r.name
        for r in list_kind(session, KIND_TECHNICIAN)
        if r.eligible and r.ext_id not in absents
    }
    groups = {r.ext_id: r.name for r in list_kind(session, KIND_GROUP) if r.eligible}
    entities = {r.ext_id: r.name for r in list_kind(session, KIND_ENTITY) if r.selected}
    return Referentials(categories=cats, technicians=techs, groups=groups, entities=entities)


def _fiche(libelle: str, row, interim: list | None = None) -> str | None:
    """Description d'un acteur éligible : domaines cochés PUIS prose libre.

    L'ordre n'est pas cosmétique. Le socle coché donne au LLM des repères stables et
    discriminants ; la prose vient APRÈS pour qu'une nuance (« ne gère pas les Mac »,
    « ne prend plus les demandes d'accès ») prime sur le domaine générique en cas de
    contradiction — c'est la dernière information lue qui pèse le plus.

    `interim` = absents que cet acteur remplace aujourd'hui, sous forme de tuples
    `(nom, skill_tags, fin)`. Leurs domaines sont FUSIONNÉS au socle : sans cela, le
    remplaçant serait proposé pour des tickets qu'il est censé absorber, mais décrit comme
    ne les couvrant pas — le modèle répondrait avec une confiance basse et le seuil
    renverrait le ticket « à trier ». On aurait déplacé le problème, pas résolu.

    Renvoie None si l'acteur n'a NI case NI prose NI intérim : l'inclure n'apprendrait rien
    au modèle et diluerait le prompt (son nom figure déjà dans la liste des éligibles).
    """
    tags = [k for k in (row.skill_tags or "").split(",") if k]
    for _, tags_absent, _ in interim or []:
        tags.extend(tags_absent)
    socle = domain_skills.describe(tags)  # `normalize` dédoublonne et remet dans l'ordre
    prose = (row.skills or "").strip()
    if not socle and not prose and not interim:
        return None
    lignes = [f"{libelle} {row.ext_id} ({row.name}) :"]
    if socle:
        lignes.append(f"Domaines : {socle}")
    if prose:
        lignes.append(prose)
    # L'intérim est annoncé EN DERNIER, donc avec le plus de poids : c'est l'information la
    # plus fraîche et la plus décisive pour la journée en cours.
    for nom, _, fin in interim or []:
        lignes.append(f"Assure l'intérim de {nom} jusqu'au {fin:%d/%m/%Y} inclus.")
    return "\n".join(lignes)


def skill_coverage(session: Session) -> dict[str, dict[str, int]]:
    """Combien d'acteurs ÉLIGIBLES couvrent chaque domaine du catalogue (routage, FR-15).

    Diagnostic PRÉDICTIF, pas une statistique : un domaine que personne ne couvre garantit
    un « à trier » le jour où un ticket en relève — l'admin le découvrait jusqu'ici dans le
    Journal, trois semaines plus tard. Un domaine couvert par UN SEUL technicien est un
    point de défaillance unique, donc un trou le jour de son congé.

    Techniciens et groupes sont comptés SÉPARÉMENT : un groupe absorbe une absence sans
    configuration, un technicien seul non. Fusionner les deux compteurs effacerait
    exactement la nuance qui rend l'alerte actionnable.

    Anti-mouchard (FR-18/21) : on renvoie des CARDINALITÉS par domaine, jamais un acteur
    nommé ni une métrique par technicien — c'est une carte de la configuration, pas une
    mesure des personnes.
    """
    coverage = {d.key: {"technicians": 0, "groups": 0} for d in domain_skills.SKILL_CATALOG}
    for kind, compteur in ((KIND_TECHNICIAN, "technicians"), (KIND_GROUP, "groups")):
        for row in list_kind(session, kind):
            if not row.eligible:
                continue
            # `normalize` écarte les clés d'un catalogue antérieur : sans lui, une sélection
            # obsolète en base ferait exploser un domaine qui n'existe plus.
            for key in domain_skills.normalize((row.skill_tags or "").split(",")):
                coverage[key][compteur] += 1
    return coverage


def routing_prose(session: Session, *, tz_name: str | None = None) -> str:
    """Description des techniciens et groupes ÉLIGIBLES (pour le routage, FR-15).

    ⚠️ Un acteur sans description reste routable (son nom est listé dans le prompt) mais le
    modèle doit alors deviner son périmètre à partir d'un patronyme. Mesuré sur une instance
    aux fiches vides : 7 propositions sur 20 rejetées en `low_confidence`. D'où les domaines
    cochables — un socle en quelques clics, sans rédaction.

    Les absents du jour sont EXCLUS (cohérent avec `effective_referentials` : décrire au
    modèle quelqu'un qu'il n'a pas le droit de proposer ne ferait que diluer le prompt), et
    leurs remplaçants héritent de leurs domaines.
    """
    day = absences.today_local(tz_name)
    absents = absences.absent_ext_ids(session, day)
    interims = absences.interim_context(session, day)
    actifs = absences.active_on(session, day)
    techs = [r for r in list_kind(session, KIND_TECHNICIAN) if r.eligible]
    par_id = {r.ext_id: r for r in techs}

    def _interim_de(ext_id: int) -> list:
        """Absents couverts par cet acteur : (nom, domaines hérités, dernier jour d'absence)."""
        couverts = []
        for absent_id in interims.get(ext_id, []):
            ligne = par_id.get(absent_id)
            fin = max(
                (a.end_date for a in actifs if a.technician_ext_id == absent_id), default=day
            )
            couverts.append((
                ligne.name if ligne else f"#{absent_id}",
                [k for k in (ligne.skill_tags or "").split(",") if k] if ligne else [],
                fin,
            ))
        return couverts

    blocks = [
        f for f in (
            [_fiche("Technicien", r, _interim_de(r.ext_id)) for r in techs if r.ext_id not in absents]
            + [_fiche("Groupe", r) for r in list_kind(session, KIND_GROUP) if r.eligible]
        ) if f
    ]
    return "\n\n".join(blocks)
