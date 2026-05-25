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
