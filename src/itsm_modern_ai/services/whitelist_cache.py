"""Cache mémoire de la Whitelist (FR-3).

Rafraîchi à chaque polling. En mémoire process (pas de Redis, cf. architecture).
Tant qu'aucun référentiel n'a été chargé, la Whitelist est vide → toute Décision
part « à trier » (sûr par défaut).
"""

from __future__ import annotations

from ..domain.models import Referentials


class WhitelistCache:
    def __init__(self) -> None:
        self._refs = Referentials()

    @property
    def referentials(self) -> Referentials:
        return self._refs

    def refresh(self, refs: Referentials) -> None:
        self._refs = refs

    @property
    def is_loaded(self) -> bool:
        return bool(self._refs.categories or self._refs.technicians)
