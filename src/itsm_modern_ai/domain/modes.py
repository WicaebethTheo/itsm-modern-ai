"""Modes d'exécution & dispatch de l'action finale (post-garde-fous).

Le moteur à garde-fous (`engine.evaluate`) décide si une Décision est ACCEPTÉE
(whitelist + seuil OK) ou part « à trier ». Ce module décide, pour une Décision
acceptée, **ce qu'on en fait** selon le mode d'exécution configuré pour le périmètre :

- `suggestion` : on écrit seulement un Suivi privé (aucune mutation GLPI). Défaut.
- `semi_auto`  : on applique la Décision (catégorie, priorité, assignation) **si**
  la confiance atteint un 2ᵉ seuil strict (`auto_min_confidence`) ; sinon, on
  retombe sur le comportement suggestion.
- `full_auto`  : on applique la Décision (la confiance a déjà passé le seuil normal
  à l'étape `engine.evaluate`).

Invariants préservés : la fonction est **pure** et ne s'applique qu'à une Décision
DÉJÀ acceptée par le garde-fou déterministe. Le Suivi privé est **toujours** écrit
quand on agit (traçabilité/audit, FR-19/20), même en mode auto.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel

from .models import TriageOutcome


class ExecutionMode(StrEnum):
    SUGGESTION = "suggestion"
    SEMI_AUTO = "semi_auto"
    FULL_AUTO = "full_auto"


class TriageAction(BaseModel):
    """Ce que le service de triage doit faire d'une Décision acceptée.

    `apply` : muter les champs GLPI (catégorie, priorité, assignation) via le port.
    `write_followup` : déposer le Suivi privé (toujours vrai quand on agit — audit).
    `mode` : mode effectivement résolu pour le périmètre (journalisé).
    """

    apply: bool
    write_followup: bool
    mode: ExecutionMode


def resolve_action(
    outcome: TriageOutcome,
    mode: ExecutionMode,
    auto_min_confidence: float,
) -> TriageAction:
    """Décide l'action finale pour une Décision acceptée, selon le mode du périmètre.

    Ne s'applique qu'à un `outcome.accepted` ; sinon (= « à trier ») aucune action
    (ni mutation ni Suivi) — c'est l'appelant qui journalise le repli.
    """
    if not outcome.accepted or outcome.decision is None:
        return TriageAction(apply=False, write_followup=False, mode=mode)

    if mode is ExecutionMode.FULL_AUTO:
        apply = True
    elif mode is ExecutionMode.SEMI_AUTO:
        apply = outcome.decision.confidence >= auto_min_confidence
    else:  # SUGGESTION
        apply = False

    return TriageAction(apply=apply, write_followup=True, mode=mode)
