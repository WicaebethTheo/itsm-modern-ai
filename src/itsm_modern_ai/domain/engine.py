"""Moteur à garde-fous — l'ADN du produit (intouchable).

Pipeline à ORDRE IMMUABLE (project-context.md invariant 1) :

    Masquage → appel LLM (JSON mode) → validation Pydantic → validation Whitelist
    → seuil de confiance → dépôt / « à trier »

Ce module couvre les deux dernières étapes déterministes (Whitelist + seuil) à
partir d'une `Decision` DÉJÀ parsée/validée par Pydantic à la frontière adaptateur.
Le masquage et l'appel LLM sont orchestrés en amont (cf. services/ et le spike).

« à trier » est la SEULE échappatoire (invariant 3) — jamais d'autre branche.
"""

from __future__ import annotations

from . import whitelist
from .models import Decision, Referentials, TriageOutcome, TriageReason


def evaluate(decision: Decision, refs: Referentials, confidence_threshold: float) -> TriageOutcome:
    """Applique Whitelist puis seuil de confiance à une Décision parsée.

    Whitelist AVANT le seuil : un ID hors-liste est rejeté quelle que soit la
    confiance auto-déclarée (qui n'est pas calibrée, cf. FR-8).
    """
    # On porte TOUJOURS la Décision LLM brute dans l'outcome — même rejeté — pour que
    # la sandbox/journal puissent montrer le brouillon, le routage et la confiance
    # tentés (utile en pilote pour comprendre POURQUOI ça a été trié à la main).
    # Le `accepted=False` reste la barrière : aucune écriture GLPI n'est faite sans.
    rejection = whitelist.check(decision, refs)
    if rejection is not None:
        return TriageOutcome(accepted=False, reason=rejection, decision=decision)

    if decision.confidence < confidence_threshold:
        return TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE, decision=decision)

    return TriageOutcome(accepted=True, reason=TriageReason.ACCEPTED, decision=decision)
