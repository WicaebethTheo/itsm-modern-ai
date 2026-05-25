"""Boîte à secrets chiffrée (Fernet / AES-128-CBC + HMAC) — FR-25.

Master key : fournie via env `MASTER_KEY` (clé Fernet urlsafe base64 de 32 octets),
sinon générée et persistée dans `data/master.key`. Epic 4 durcira la gestion de
clé (secret monté, rotation) ; l'interface SecretsPort ne changera pas.
"""

from __future__ import annotations

import logging
from pathlib import Path

from cryptography.fernet import Fernet

logger = logging.getLogger("itsm.secrets")


def _load_or_create_key(master_key: str, key_file: Path) -> bytes:
    if master_key:
        return master_key.encode()
    if key_file.exists():
        return key_file.read_bytes()
    key = Fernet.generate_key()
    key_file.parent.mkdir(parents=True, exist_ok=True)
    key_file.write_bytes(key)
    key_file.chmod(0o600)
    # ⚠️ Une NOUVELLE clé a été générée : tout secret chiffré avec une ancienne clé
    # devient illisible (à re-saisir). Pour éviter ça, FIXER MASTER_KEY dans .env.
    logger.warning(
        "MASTER_KEY non fournie : nouvelle clé de chiffrement générée dans %s. "
        "Si une ancienne clé existait, les secrets précédents sont désormais illisibles. "
        "Fixez MASTER_KEY dans .env pour une persistance fiable des secrets.",
        key_file,
    )
    return key


class FernetSecretsBox:
    """Implémente `SecretsPort` avec Fernet."""

    def __init__(self, master_key: str = "", key_file: str | Path = "data/master.key") -> None:
        self._key = _load_or_create_key(master_key, Path(key_file))
        self._fernet = Fernet(self._key)

    @property
    def key(self) -> bytes:
        """Clé brute — sert aussi de secret de signature des sessions (FR-24)."""
        return self._key

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, token: str) -> str:
        return self._fernet.decrypt(token.encode()).decode()
