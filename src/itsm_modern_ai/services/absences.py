"""Absences et remplaçants — retirer un technicien du pool, transmettre ses compétences.

DEUX APPROCHES ÉTAIENT POSSIBLES, une seule est correcte :

1. Laisser le LLM proposer l'absent, puis substituer le remplaçant après coup. **Non** :
   cela crée une divergence entre ce que le Journal enregistre et ce que GLPI reçoit —
   exactement le trou d'audit que `whitelist.effective_assignment` a été écrit pour boucher.
2. **Retirer l'absent du périmètre effectif.** Déterministe : jamais proposé, donc jamais
   assigné, et cela compose gratuitement avec tout l'aval (whitelist, seuil, repli).

C'est la 2 qui est implémentée. Le filtre prend effet SEUL, sans invalidation de cache :
`build_triage_service` et les référentiels effectifs sont reconstruits à CHAQUE cycle de
poll (`api/app.py`). Corollaire précieux : **l'absence expire toute seule** — personne n'a
besoin de penser à réactiver quelqu'un le lundi matin.

LE POINT QUI DÉCIDE SI ÇA MARCHE OU FAIT SEMBLANT : le remplaçant hérite des **compétences**
de l'absent, pas seulement de son nom. Dire au modèle « route vers B plutôt que vers A »
sans lui dire *pourquoi* B convient, c'est lui demander d'assigner du réseau à quelqu'un
décrit comme faisant de la bureautique : il le fera avec une confiance basse, et le seuil le
renverra… « à trier ». On aurait déplacé le problème, pas résolu. Cf. `interim_context`.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, select

from ..persistence.tables import TechnicianAbsence

logger = logging.getLogger("itsm.absences")

DEFAULT_TIMEZONE = "Europe/Paris"


def today_local(tz_name: str | None = None) -> date:
    """Date du jour dans le fuseau CONFIGURÉ — jamais en UTC.

    Ne se voit qu'en production, en août : évaluée en UTC, une absence se terminerait à 02 h
    du matin le bon jour (ou la veille selon la saison) pour une équipe à Paris. Les bornes
    étant inclusives et à granularité jour, seul le « quel jour sommes-nous ICI ? » compte.

    Un fuseau invalide retombe sur le défaut documenté plutôt que de lever : une faute de
    frappe dans un réglage ne doit pas arrêter le triage de toute une file.
    """
    name = (tz_name or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
    try:
        tz = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        logger.warning("fuseau horaire inconnu (%s) — repli sur %s", name, DEFAULT_TIMEZONE)
        tz = ZoneInfo(DEFAULT_TIMEZONE)
    return datetime.now(tz).date()


def list_absences(session: Session) -> list[TechnicianAbsence]:
    return list(
        session.exec(
            select(TechnicianAbsence).order_by(
                TechnicianAbsence.start_date, TechnicianAbsence.technician_ext_id
            )
        ).all()
    )


def active_on(session: Session, day: date) -> list[TechnicianAbsence]:
    """Absences couvrant `day`, bornes INCLUSES (un congé « du 10 au 22 » inclut le 22)."""
    return [a for a in list_absences(session) if a.start_date <= day <= a.end_date]


def absent_ext_ids(session: Session, day: date) -> set[int]:
    """Techniciens à retirer du périmètre effectif pour cette journée."""
    return {a.technician_ext_id for a in active_on(session, day)}


def interim_context(session: Session, day: date) -> dict[int, list[int]]:
    """`{remplaçant: [absents qu'il couvre]}` pour la journée.

    UN SEUL SAUT, volontairement. Si A est absent et remplacé par B, lui-même absent, on ne
    cherche PAS le remplaçant de B : construire un résolveur de graphe rendrait le
    comportement mathématiquement complet et humainement imprévisible. Un admin qui débarque
    doit pouvoir lire la configuration et savoir ce qui va se passer. Le cas « B est lui-même
    absent » est d'ailleurs refusé à la saisie (cf. la route), donc il ne survit ici qu'à une
    absence posée APRÈS coup — et dans ce cas B sort simplement du pool, comme A.
    """
    absents = absent_ext_ids(session, day)
    interims: dict[int, list[int]] = {}
    for absence in active_on(session, day):
        remplacant = absence.replacement_ext_id
        # Un remplaçant lui-même absent ne remplace personne : il n'est plus dans le pool.
        if remplacant is None or remplacant in absents:
            continue
        interims.setdefault(remplacant, []).append(absence.technician_ext_id)
    return interims


def replace_all(session: Session, items: list[dict]) -> None:
    """Remplace la liste complète des absences (même style que le périmètre).

    La validation métier (remplaçant éligible, cohérence des dates) est faite EN AMONT par
    la route : ce service écrit ce qu'on lui donne, une fois la décision prise.
    """
    for row in list_absences(session):
        session.delete(row)
    for it in items:
        session.add(
            TechnicianAbsence(
                technician_ext_id=int(it["technician_ext_id"]),
                start_date=it["start_date"],
                end_date=it["end_date"],
                replacement_ext_id=(
                    int(it["replacement_ext_id"]) if it.get("replacement_ext_id") is not None else None
                ),
                note=str(it.get("note", "") or ""),
            )
        )
    session.commit()


def purge_ended_before(session: Session, cutoff: date) -> int:
    """Supprime les absences TERMINÉES avant `cutoff`. Renvoie le nombre de lignes.

    RGPD : une absence passée est une donnée personnelle sans utilité opérationnelle. On la
    purge avec le reste plutôt que d'accumuler l'historique des congés de chacun — le produit
    n'a aucune raison de savoir qui était en vacances il y a deux ans.
    """
    perimees = [a for a in list_absences(session) if a.end_date < cutoff]
    for row in perimees:
        session.delete(row)
    if perimees:
        session.commit()
    return len(perimees)
