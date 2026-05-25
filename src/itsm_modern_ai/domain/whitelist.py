"""Validation déterministe contre la Whitelist (FR-7).

Frontière de confiance du produit : tout ID renvoyé par le LLM hors des
référentiels GLPI → rejet. Le LLM propose, le code décide.
"""

from __future__ import annotations

from .models import Decision, Referentials, TriageReason


def check(decision: Decision, refs: Referentials) -> TriageReason | None:
    """Renvoie la raison de rejet, ou None si tous les IDs sont whitelistés.

    Ordre : catégorie → priorité → technicien. Aucune écriture n'a lieu tant
    que cette fonction n'a pas renvoyé None.
    """
    if decision.category not in refs.categories:
        return TriageReason.CATEGORY_NOT_IN_WHITELIST
    if decision.priority not in refs.priorities:
        return TriageReason.PRIORITY_NOT_IN_WHITELIST
    if decision.technician_id not in refs.technicians:
        return TriageReason.TECHNICIAN_NOT_IN_WHITELIST
    return None
