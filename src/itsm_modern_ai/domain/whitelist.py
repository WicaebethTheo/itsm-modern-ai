"""Validation déterministe contre la Whitelist effective (FR-7).

Frontière de confiance du produit : tout ID renvoyé par le LLM hors du périmètre
AUTORISÉ par l'admin (catégories sélectionnées, techniciens/groupes éligibles) est
rejeté. Le LLM propose, le code décide.
"""

from __future__ import annotations

from .models import Decision, Referentials, TriageReason


def check(decision: Decision, refs: Referentials) -> TriageReason | None:
    """Renvoie la raison de rejet, ou None si la Décision est dans le périmètre.

    Ordre : catégorie → priorité → assignation (technicien OU groupe éligible).
    Aucune écriture n'a lieu tant que cette fonction n'a pas renvoyé None.
    """
    if decision.category not in refs.categories:
        return TriageReason.CATEGORY_NOT_IN_WHITELIST
    if decision.priority not in refs.priorities:
        return TriageReason.PRIORITY_NOT_IN_WHITELIST

    technician_ok = decision.technician_id is not None and decision.technician_id in refs.technicians
    group_ok = decision.group_id is not None and decision.group_id in refs.groups
    # Un ID d'assignation proposé mais hors périmètre est un signal d'erreur franc.
    if decision.technician_id is not None and not technician_ok and not group_ok:
        return TriageReason.TECHNICIAN_NOT_IN_WHITELIST
    if not technician_ok and not group_ok:
        return TriageReason.NO_ELIGIBLE_ASSIGNEE
    return None


def effective_assignment(decision: Decision, refs: Referentials) -> tuple[int | None, int | None]:
    """Assignation RÉELLEMENT applicable, filtrée contre le périmètre (FR-7).

    Défense en profondeur au moment de l'écriture : même quand `check()` a accepté la
    Décision (au moins un acteur éligible), le LLM peut avoir proposé un `technician_id`
    HORS whitelist accompagné d'un groupe éligible. Or le mapper GLPI **préfère** le
    technicien → sans ce filtre, un utilisateur jamais validé par l'admin serait assigné
    dans GLPI pendant que le Journal afficherait le groupe (trou d'audit + contournement
    de la frontière de confiance, exploitable par prompt-injection).

    On ne retourne donc un ID que s'il est éligible : technicien si dans le périmètre,
    sinon groupe si dans le périmètre, sinon rien. Utilisé par la mutation GLPI ET le
    rendu du Suivi → les deux reflètent le MÊME acteur.
    """
    tech = decision.technician_id if decision.technician_id in refs.technicians else None
    group = decision.group_id if decision.group_id in refs.groups else None
    return tech, group
