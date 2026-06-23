"""Feature Supporter : multi-entités avancé.

Résolution fine des politiques de triage par entité, avec héritage hiérarchique
(une entité enfant hérite de la politique du parent sauf override explicite).

Le core gère déjà un mode par entité simple (override du défaut global) ; cette feature
ajoute l'héritage hiérarchique et des seuils de confiance par entité.
"""

from __future__ import annotations

from dataclasses import dataclass

from itsm_modern_ai.domain.licensing import FEATURE_MULTI_ENTITY


@dataclass(frozen=True)
class EntityPolicy:
    entity_id: int
    parent_id: int | None
    execution_mode: str | None = None  # None = hérite du parent
    confidence_threshold: float | None = None


class MultiEntityResolver:
    """Résout la politique EFFECTIVE d'une entité en remontant la hiérarchie."""

    def __init__(self, policies: dict[int, EntityPolicy] | None = None) -> None:
        self._policies = policies or {}

    def effective_mode(self, entity_id: int, *, global_default: str) -> str:
        seen: set[int] = set()
        cur: int | None = entity_id
        while cur is not None and cur not in seen:
            seen.add(cur)
            pol = self._policies.get(cur)
            if pol is None:
                break
            if pol.execution_mode is not None:
                return pol.execution_mode
            cur = pol.parent_id
        return global_default


def register(registry) -> None:
    registry.register_feature(FEATURE_MULTI_ENTITY, MultiEntityResolver())
