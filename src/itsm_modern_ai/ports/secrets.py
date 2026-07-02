"""Port secrets — chiffrement/déchiffrement des secrets au repos (FR-25)."""

from __future__ import annotations

from typing import Protocol


class SecretsPort(Protocol):
    """Boîte à secrets. Les valeurs en base sont des chaînes chiffrées opaques."""

    def encrypt(self, plaintext: str) -> str:
        """Chiffre une valeur en clair → token stockable."""
        ...

    def decrypt(self, token: str) -> str:
        """Déchiffre un token → valeur en clair."""
        ...
