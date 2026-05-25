"""Boîte à secrets chiffrée (Fernet / AES-128-CBC + HMAC) — FR-25.

Master key : fournie via env `MASTER_KEY` (clé Fernet urlsafe base64 de 32 octets),
sinon générée et persistée dans `data/master.key`. Epic 4 durcira la gestion de
clé (secret monté, rotation) ; l'interface SecretsPort ne changera pas.
"""

from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet


def _load_or_create_key(master_key: str, key_file: Path) -> bytes:
    if master_key:
        return master_key.encode()
    if key_file.exists():
        return key_file.read_bytes()
    key = Fernet.generate_key()
    key_file.parent.mkdir(parents=True, exist_ok=True)
    key_file.write_bytes(key)
    key_file.chmod(0o600)
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
