"""Point d'extension open-core — découverte des modules Enterprise (entry points).

Le core ne connaît PAS l'implémentation des features payantes : il expose un registre
et un loader. Le package overlay `itsm_modern_ai_enterprise`, s'il est installé, déclare
un entry point dans le groupe `itsm_modern_ai.plugins` ; sa fonction `register(registry)`
enregistre les implémentations.

Conséquence (et garantie de la séparation) : sur l'image **Community**, le code payant
n'est tout simplement pas installé → `installed_features()` est vide → la feature reste
verrouillée même avec une licence. Sur l'image **Enterprise**, l'implémentation est là ;
elle s'active si la **licence** l'autorise (cf. services/license_service).
"""

from __future__ import annotations

import logging
from importlib.metadata import entry_points
from typing import Any

logger = logging.getLogger("itsm.plugins")

ENTRY_POINT_GROUP = "itsm_modern_ai.plugins"


class PluginRegistry:
    """Registre des implémentations de features fournies par les plugins installés."""

    def __init__(self) -> None:
        self._features: dict[str, Any] = {}

    def register_feature(self, key: str, provider: Any) -> None:
        """Déclare qu'une feature payante est IMPLÉMENTÉE (code présent dans l'image)."""
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
    """Fabrique un registre et y charge les plugins installés."""
    return load_plugins(PluginRegistry())
