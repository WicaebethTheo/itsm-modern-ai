"""Frontière de validation de la Décision LLM, partagée par tous les adaptateurs.

Le modèle `Decision` est désormais STRICT (`strict=True`) : plus aucune coercition
silencieuse de Pydantic. C'était nécessaire — `{"category": true}` devenait
`category=1` et une Décision était acceptée sur la catégorie #1 sans que le modèle
n'en ait proposé aucune.

Reste un cas de compatibilité réel : certaines passerelles / petits modèles locaux
sérialisent leurs nombres en CHAÎNE (`"priority": "3"`) ou en flottant entier
(`"category": 3.0`). On les rattrape ICI, EXPLICITEMENT, champ par champ, et
uniquement pour les formes non ambiguës — jamais dans le modèle de domaine :
- une chaîne strictement numérique → nombre ;
- un flottant à partie décimale nulle → entier (champs entiers) ;
- un **booléen n'est JAMAIS converti** (`True` est un `int` en Python : c'est
  exactement le trou que le durcissement referme) ;
- tout le reste part tel quel et se fera rejeter par Pydantic → `invalid_output`.
"""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from ...domain.errors import LlmResponseError
from ...domain.models import Decision

# Champs entiers (ou entiers nullables) du schéma Décision.
_INT_FIELDS = ("category", "priority", "technician_id", "group_id")
# Champs flottants du schéma Décision.
_FLOAT_FIELDS = ("confidence",)


def _as_int(value: Any) -> Any:
    """Convertit une forme numérique non ambiguë en `int`, sinon renvoie tel quel."""
    if isinstance(value, bool):
        return value  # jamais de bool → int : c'est la faille que l'on referme
    if isinstance(value, str):
        text = value.strip()
        try:
            return int(text)
        except ValueError:
            try:
                as_float = float(text)
            except ValueError:
                return value
            return int(as_float) if as_float.is_integer() else value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _as_float(value: Any) -> Any:
    """Convertit une chaîne numérique en `float`, sinon renvoie tel quel."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return value
    return value


def coerce_numeric_fields(data: Any) -> Any:
    """Coercition explicite des champs numériques d'un payload Décision brut."""
    if not isinstance(data, dict):
        return data
    out = dict(data)
    for field in _INT_FIELDS:
        if field in out:
            out[field] = _as_int(out[field])
    for field in _FLOAT_FIELDS:
        if field in out:
            out[field] = _as_float(out[field])
    return out


def parse_decision(data: Any) -> Decision:
    """Coercition explicite puis validation STRICTE. Lève `LlmResponseError` si KO."""
    try:
        return Decision.model_validate(coerce_numeric_fields(data))
    except ValidationError as exc:
        raise LlmResponseError(f"Décision non conforme au schéma: {exc}") from exc
