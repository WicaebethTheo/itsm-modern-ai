"""Registre des features et chargement des plugins (open-core, édition unique).

Les features Supporter sont LIVRÉES dans cette image (package `itsm_modern_ai.features`)
mais restent verrouillées tant qu'une licence valide ne les autorise pas. `build_registry()`
enregistre ces features intégrées, puis charge tout plugin externe déclaré via entry point
dans le groupe `itsm_modern_ai.plugins`.

Conséquence : `installed_features()` contient toujours les 3 clés Supporter (le code est
présent). L'activation réelle dépend de la **licence** (cf. services/license_service) :
`active = installed ∧ entitled`.
"""

from __future__ import annotations

import logging
from importlib.metadata import entry_points
from typing import Any

logger = logging.getLogger("itsm.plugins")

ENTRY_POINT_GROUP = "itsm_modern_ai.plugins"


class PluginRegistry:
    """Registre des implémentations de features fournies par l'image et les plugins installés."""

    def __init__(self) -> None:
        self._features: dict[str, Any] = {}

    def register_feature(self, key: str, provider: Any) -> None:
        """Déclare qu'une feature gatée est IMPLÉMENTÉE (code présent dans l'image)."""
        if key in self._features:
            logger.warning("feature plugin '%s' déjà enregistrée — écrasée", key)
        self._features[key] = provider
        logger.info("feature plugin enregistrée: %s", key)

    def installed_features(self) -> frozenset[str]:
        return frozenset(self._features)

    def provider(self, key: str) -> Any | None:
        return self._features.get(key)


def load_plugins(registry: PluginRegistry) -> PluginRegistry:
    """Charge tous les plugins déclarés via entry points. Tolérant aux pannes :
    un plugin défaillant est journalisé et ignoré (ne casse pas le démarrage)."""
    try:
        eps = entry_points(group=ENTRY_POINT_GROUP)
    except Exception:  # pragma: no cover - API entry_points très stable en 3.13
        logger.exception("découverte des plugins impossible")
        return registry

    for ep in eps:
        try:
            register = ep.load()
            register(registry)
        except Exception:
            logger.exception("chargement du plugin '%s' échoué — ignoré", ep.name)
    return registry


def build_registry() -> PluginRegistry:
    """Fabrique un registre, y enregistre les features intégrées puis les plugins externes."""
    registry = PluginRegistry()
    from . import features

    features.register(registry)
    return load_plugins(registry)
