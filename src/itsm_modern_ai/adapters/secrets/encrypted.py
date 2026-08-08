"""Boîte à secrets chiffrée (Fernet / AES-128-CBC + HMAC) — FR-25.

Master key : fournie via env `MASTER_KEY` (clé Fernet urlsafe base64 de 32 octets),
sinon générée et persistée dans `data/master.key`. Epic 4 durcira la gestion de
clé (secret monté, rotation) ; l'interface SecretsPort ne changera pas.

Garde-fou d'exploitation : la clé n'est générée que s'il n'y a RIEN à perdre. Si
`data/master.key` a disparu alors que la base contient déjà des secrets chiffrés, on
lève `MasterKeyLostError` au lieu de démarrer sur une clé neuve — sans quoi l'instance
démarrerait « au vert » mais cassée (login refusé, secrets muets) sans rien pour la
réparer. Échappatoire explicite : `ITSM_ALLOW_NEW_MASTER_KEY=true`.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from ...domain.errors import SecretDecryptError

logger = logging.getLogger("itsm.secrets")

# Échappatoire explicite : « je sais que je repars de zéro, régénère la clé ».
# Volontairement une variable d'environnement brute (pas un réglage `Settings`) : elle
# n'a de sens qu'au boot, une seule fois, et doit être RETIRÉE juste après.
ALLOW_NEW_KEY_ENV = "ITSM_ALLOW_NEW_MASTER_KEY"

# Nom du fichier de base SQLite cherché à côté de `master.key` (même volume ./data)
# pour répondre à « y a-t-il des secrets à perdre ? » avant l'ouverture du moteur.
_SIBLING_DB_NAME = "itsm.db"


class MasterKeyLostError(RuntimeError):
    """La clé maître a disparu alors que la base contient déjà des secrets chiffrés.

    Fail-fast VOLONTAIRE : générer une nouvelle clé ici ferait démarrer un moteur
    « vert » mais cassé (login refusé avec un diagnostic trompeur, GLPI/LLM muets),
    et rien ne le réparerait ensuite.
    """


def _existing_secrets(key_file: Path) -> bool | None:
    """Y a-t-il DÉJÀ des secrets chiffrés en base ? (None = indéterminable)

    Import local et tardif : `encrypted.py` est un adaptateur, il ne doit pas dépendre
    de la persistance au chargement du module (couplage circulaire). On interroge le
    moteur s'il est ouvert, sinon la base SQLite voisine du fichier de clé — c'est
    exactement le cas de perte visé : `./data` où cohabitent `itsm.db` et `master.key`.
    """
    try:
        from ...persistence.db import has_encrypted_secrets

        return has_encrypted_secrets(key_file.parent / _SIBLING_DB_NAME)
    except Exception:  # pragma: no cover - filet : jamais bloquer sur le garde-fou
        return None


def _load_or_create_key(master_key: str, key_file: Path) -> bytes:
    if master_key:
        return master_key.encode()
    if key_file.exists():
        return key_file.read_bytes()

    # ── Garde-fou : refus de générer une clé PAR-DESSUS des secrets existants ──
    # Premier démarrage légitime (base vide ou absente) → `False`/`None` → on génère.
    if _existing_secrets(key_file) is True and not _allow_new_key():
        raise MasterKeyLostError(
            f"CLÉ DE CHIFFREMENT INTROUVABLE : {key_file} a disparu alors que la base "
            "contient déjà des secrets chiffrés (mot de passe admin, tokens GLPI, clé LLM).\n"
            "Générer une nouvelle clé les rendrait DÉFINITIVEMENT illisibles — démarrage "
            "refusé pour ne pas transformer une perte de fichier en panne silencieuse "
            "(« mot de passe incorrect » à la connexion).\n"
            "Que faire, au choix :\n"
            f"  1) RESTAURER la clé : remettre {key_file} depuis votre sauvegarde "
            "(backups/<horodatage>/master.key), ou renseigner MASTER_KEY dans .env avec "
            "la valeur d'origine — puis redémarrer. C'est la seule option qui préserve "
            "les secrets.\n"
            "  2) RESTAURER l'ensemble base + clé : ./install.sh --rollback <horodatage>.\n"
            "  3) REPARTIR DE ZÉRO en connaissance de cause (mot de passe admin, tokens "
            f"GLPI et clé LLM à ressaisir) : démarrer une fois avec {ALLOW_NEW_KEY_ENV}=true, "
            "puis RETIRER cette variable."
        )

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


def _allow_new_key() -> bool:
    allowed = os.environ.get(ALLOW_NEW_KEY_ENV, "").strip().lower() in {"1", "true", "yes", "on"}
    if allowed:
        logger.warning(
            "%s=true : génération d'une NOUVELLE clé maître malgré des secrets existants. "
            "Ils sont désormais illisibles et doivent être ressaisis (mot de passe admin, "
            "tokens GLPI, clé LLM). Retirez cette variable après ce démarrage.",
            ALLOW_NEW_KEY_ENV,
        )
    return allowed


class FernetSecretsBox:
    """Implémente `SecretsPort` avec Fernet."""

    def __init__(self, master_key: str = "", key_file: str | Path = "data/master.key") -> None:
        self._key = _load_or_create_key(master_key, Path(key_file))
        self._fernet = Fernet(self._key)

    @property
    def key(self) -> bytes:
        """Clé brute de chiffrement (Fernet). NE PAS réutiliser directement pour
        signer les sessions : utiliser `derive_key(info=...)` (séparation des usages)."""
        return self._key

    def derive_key(self, info: bytes, length: int = 32) -> bytes:
        """Dérive une sous-clé DISTINCTE et STABLE depuis la clé maître résolue (HKDF).

        Sécurité (durcissement audit 2026-05) : la clé Fernet ne doit pas servir AUSSI
        de secret de signature des sessions. On dérive une clé dédiée via HKDF-SHA256 en
        variant `info` (ex. b"session-signing"). La sortie est déterministe pour une même
        clé maître → stable entre redémarrages (à condition que MASTER_KEY soit fixé ou
        que data/master.key persiste, ce que résout `_load_or_create_key`).
        """
        hkdf = HKDF(algorithm=hashes.SHA256(), length=length, salt=None, info=info)
        return hkdf.derive(self._key)

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, token: str) -> str:
        """Déchiffre un token. Fail-safe : un token illisible (clé incohérente / token
        corrompu) lève `SecretDecryptError` (erreur métier) plutôt qu'un `InvalidToken`
        brut → évite un HTTP 500 qui verrouillerait l'admin (audit 2026-05)."""
        try:
            return self._fernet.decrypt(token.encode()).decode()
        except (InvalidToken, ValueError, TypeError) as exc:
            logger.warning(
                "secret illisible : déchiffrement Fernet échoué (MASTER_KEY incohérente "
                "ou token corrompu). Le secret doit être reconfiguré."
            )
            raise SecretDecryptError(
                "Secret illisible (clé de chiffrement incohérente). Reconfigurez ce secret."
            ) from exc
