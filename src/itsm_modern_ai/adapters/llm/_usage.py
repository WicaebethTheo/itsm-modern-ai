"""Comptabilité des tokens d'un appel LLM — anti « coût 0 » silencieux.

Les adaptateurs lisaient `usage.get("prompt_tokens", 0)`. Une passerelle qui n'émet
PAS de bloc `usage` (proxy maison, Ollama derrière un routeur, LiteLLM mal configuré)
faisait donc avancer le compteur de **0,00 € par appel, indéfiniment** : le plafond de
coût (FR-10) n'était jamais atteint alors que le fournisseur facturait bel et bien.

Règle retenue : une comptabilité absente ou nulle est une ANOMALIE, pas un gratuité.
On estime alors les tokens depuis la longueur des textes réellement échangés et on
LOGGE un warning nommant le modèle — l'exploitant doit savoir que son plafond
s'appuie sur une estimation, pas sur la facturation du fournisseur.
"""

from __future__ import annotations

import logging
from typing import Any

from ...domain.models import estimate_tokens


def tokens_or_estimate(
    usage: dict[str, Any],
    key: str,
    text: str,
    *,
    logger: logging.Logger,
    model: str,
    label: str,
) -> int:
    """Tokens rapportés par le fournisseur, sinon estimation depuis `text` (+ warning).

    `label` qualifie le sens à l'exploitant (« prompt » / « complétion »). Une valeur
    présente mais non entière ou ≤ 0 est traitée comme absente : un appel qui a produit
    du texte n'a jamais consommé zéro token.
    """
    raw = usage.get(key)
    if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0:
        return raw
    estimated = estimate_tokens(text)
    logger.warning(
        "usage.%s absent ou nul dans la réponse du fournisseur (modèle=%s) : "
        "tokens de %s ESTIMÉS à %d — le plafond de coût s'appuie sur une estimation, "
        "pas sur la facturation réelle.",
        key, model, label, estimated,
    )
    return estimated
