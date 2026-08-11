"""Boîte à secrets chiffrée (Fernet / AES-128-CBC + HMAC) — FR-25.

Master key : fournie via env `MASTER_KEY` (clé Fernet urlsafe base64 de 32 octets),
sinon générée et persistée dans `data/master.key`. Epic 4 durcira la gestion de
clé (secret monté, rotation) ; l'interface SecretsPort ne changera pas.

Garde-fou d'exploitation : la clé n'est générée que s'il n'y a RIEN à perdre. Si
`data/master.key` a disparu alors que la base contient déjà des secrets chiffrés, on
lève `MasterKeyLostError` au lieu de démarrer sur une clé neuve — sans quoi l'instance
démarrerait « au vert » mais cassée (login refusé, secrets muets) sans rien pour la
réparer. Échappatoire explicite : `ITSM_ALLOW_NEW_MASTER_KEY=true`.

⚠️ CE GARDE-FOU NE DOIT PAS ÊTRE FAIL-OPEN. Tant qu'un serveur injoignable rendait la même
réponse qu'une base vide, il se désarmait tout seul : on générait une clé, on la
PERSISTAIT, et au démarrage suivant `key_file.exists()` renvoyait avant même le contrôle —
plus aucun boot n'avertissait, pour une instance qui tourne « au vert » avec un login
refusé et des tokens illisibles. On distingue donc désormais « la base est vide » (rien à
perdre, on génère) de « je n'ai pas pu poser la question » (`BaseInjoignableError`) :
dans ce dernier cas on réessaie quelques fois, puis on REFUSE de démarrer sans jamais
écrire la moindre clé — une base injoignable est une panne à réparer, pas un premier
démarrage.
"""

from __future__ import annotations

import logging
import os
import time
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

# Nombre de tentatives (et délai entre elles) pour interroger la base au boot. La base et le
# moteur démarrent ensemble : quelques secondes de battement sont normales, une base
# durablement injoignable est une panne. Attributs de module pour rester pilotables en test.
ESSAIS_BASE = 5
DELAI_BASE_S = 2.0


class MasterKeyGuardError(RuntimeError):
    """Le garde-fou de la clé maître refuse le démarrage. Toujours FAIL-FAST.

    Base commune aux deux refus (clé perdue / question sans réponse) : `api/app.py` doit
    les laisser remonter tous les deux, sans quoi l'instance démarrerait sur un secret de
    session éphémère en masquant précisément le diagnostic que l'exception porte.
    """


class MasterKeyLostError(MasterKeyGuardError):
    """La clé maître a disparu alors que la base contient déjà des secrets chiffrés.

    Fail-fast VOLONTAIRE : générer une nouvelle clé ici ferait démarrer un moteur
    « vert » mais cassé (login refusé avec un diagnostic trompeur, GLPI/LLM muets),
    et rien ne le réparerait ensuite.
    """


class MasterKeyUndeterminedError(MasterKeyGuardError):
    """Base injoignable : impossible de savoir s'il y a des secrets à perdre.

    On ne génère RIEN dans ce cas — pas même une clé qu'on garderait « en attendant ».
    L'écrire suffirait à désarmer définitivement le garde-fou (cf. l'en-tête du module).
    """


def _existing_secrets() -> bool | None:
    """Y a-t-il DÉJÀ des secrets chiffrés en base ? (None = indéterminable)

    Import local et tardif : `encrypted.py` est un adaptateur, il ne doit pas dépendre
    de la persistance au chargement du module (couplage circulaire). La question n'a de
    réponse que si le moteur PostgreSQL est déjà ouvert — d'où l'ordre d'amorçage imposé
    dans `api/app.py` (moteur AVANT boîte à secrets).

    Serveur injoignable : on RÉESSAIE (le moteur et la base démarrent ensemble, la seconde
    peut arriver après le premier) puis on lève `MasterKeyUndeterminedError`. Renvoyer
    `None` ici — ce que faisait le code — revenait à répondre « base vide » à une panne
    réseau.
    """
    from ...persistence.db import BaseInjoignableError, has_encrypted_secrets

    derniere: Exception | None = None
    for essai in range(1, max(1, ESSAIS_BASE) + 1):
        try:
            return has_encrypted_secrets()
        except BaseInjoignableError as exc:
            derniere = exc
            if essai < ESSAIS_BASE:
                logger.warning(
                    "base injoignable — garde-fou master.key en attente (tentative %d/%d) : %s",
                    essai, ESSAIS_BASE, exc,
                )
                time.sleep(DELAI_BASE_S)
    raise MasterKeyUndeterminedError(
        f"BASE INJOIGNABLE : impossible de vérifier si des secrets chiffrés existent "
        f"({derniere}).\n"
        "Aucune clé de chiffrement n'a été générée, et c'est VOLONTAIRE : une clé écrite "
        "ici existerait au prochain démarrage, court-circuiterait ce garde-fou, et les "
        "secrets déjà en base (mot de passe admin, tokens GLPI, clé LLM) seraient "
        "illisibles sans que plus rien ne le signale.\n"
        "Que faire :\n"
        "  1) réparer l'accès à la base (docker compose logs postgres, DATABASE_URL) puis "
        "redémarrer — c'est le cas nominal ;\n"
        "  2) s'il s'agit RÉELLEMENT d'un premier démarrage sans base à préserver : "
        f"démarrer une fois avec {ALLOW_NEW_KEY_ENV}=true, puis retirer cette variable."
    ) from derniere


def _load_or_create_key(master_key: str, key_file: Path) -> bytes:
    if master_key:
        return master_key.encode()
    if key_file.exists():
        return key_file.read_bytes()

    # ── Garde-fou : refus de générer une clé PAR-DESSUS des secrets existants ──
    # Premier démarrage légitime (base vide, table absente, moteur pas encore ouvert)
    # → `False`/`None` → on génère. Base injoignable → exception, on ne génère RIEN.
    if not _allow_new_key() and _existing_secrets() is True:
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
