"""Authentification locale (FR-24) — mot de passe Argon2 + session cookie.

Niveau pilote, réseau interne. Le hash du mot de passe admin est stocké chiffré
(via le store de secrets). Bootstrap : si `ADMIN_PASSWORD` (env) est défini et qu'aucun
hash n'est encore stocké, il est hashé (Argon2) et stocké au premier accès.

FAIL-CLOSED (durcissement audit 2026-05) : si AUCUN mot de passe admin n'est configuré,
les endpoints d'admin sont REFUSÉS (401) par défaut. L'ancien comportement « ouvert »
(pilote sur réseau interne) doit être activé EXPLICITEMENT via `settings.dev_open_admin`.
2FA TOTP : non implémenté (OFF par défaut, PRD).
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request, status
from pwdlib import PasswordHash

from ..domain.errors import SecretDecryptError
from ..services.runtime_config import RuntimeConfigService

logger = logging.getLogger("itsm.security")
_hasher = PasswordHash.recommended()  # Argon2

HASH_KEY = "admin_password_hash"


def hash_password(plaintext: str) -> str:
    return _hasher.hash(plaintext)


def _ensure_bootstrapped(cfg: RuntimeConfigService) -> str | None:
    """Renvoie le hash admin courant, en l'amorçant depuis l'env si nécessaire.

    Fail-safe (audit 2026-05) : si le hash stocké est illisible (MASTER_KEY incohérente),
    on NE crashe PAS en 500 — on traite l'admin comme non amorcé (→ fail-closed 401 clair),
    ce qui évite de verrouiller le login derrière une erreur serveur opaque.
    """
    try:
        stored = cfg.get_secret(HASH_KEY)
    except SecretDecryptError:
        logger.error(
            "hash admin illisible (MASTER_KEY incohérente) — login impossible jusqu'à "
            "reconfiguration du mot de passe admin. Vérifiez MASTER_KEY / data/master.key."
        )
        return None
    if stored:
        return stored
    bootstrap = cfg.settings.admin_password
    if bootstrap:
        h = hash_password(bootstrap)
        cfg.set_secret(HASH_KEY, h)
        logger.info("mot de passe admin amorcé depuis ADMIN_PASSWORD")
        return h
    return None


def auth_is_configured(cfg: RuntimeConfigService) -> bool:
    return _ensure_bootstrapped(cfg) is not None


def verify_login(cfg: RuntimeConfigService, password: str) -> bool:
    h = _ensure_bootstrapped(cfg)
    if not h:
        return False
    return _hasher.verify(password, h)


def session_is_authenticated(request: Request) -> bool:
    """Vrai si la requête porte une session admin valide — SANS lever de 401.

    Sert aux endpoints publics à réponse « enrichie si authentifié » (ex. /api/status) :
    mêmes règles que `require_auth` (session active, ou admin ouvert via `dev_open_admin`
    quand aucun mot de passe n'est configuré), mais en simple prédicat.
    """
    if request.session.get("authenticated"):
        return True
    from .deps import config_service_from_request

    with config_service_from_request(request) as cfg:
        configured = auth_is_configured(cfg)
        dev_open = bool(getattr(cfg.settings, "dev_open_admin", False))
    return not configured and dev_open


def require_auth(request: Request) -> None:
    """Dépendance : protège les endpoints d'admin (config, sandbox, journal, export).

    FAIL-CLOSED : si aucun mot de passe admin n'est configuré, l'accès est REFUSÉ (401)
    par défaut. Seul `settings.dev_open_admin=True` rouvre l'admin sans mot de passe
    (ancien comportement « pilote réseau interne », à n'utiliser qu'en dev/labo).
    """
    from .deps import config_service_from_request

    with config_service_from_request(request) as cfg:
        configured = auth_is_configured(cfg)
        dev_open = bool(getattr(cfg.settings, "dev_open_admin", False))
    if not configured:
        if dev_open:
            logger.warning(
                "accès admin OUVERT sans mot de passe (dev_open_admin=true) — ne JAMAIS utiliser en prod"
            )
            return
        # Fail-closed : pas de mot de passe + pas d'ouverture explicite → refus.
        logger.warning(
            "accès admin refusé : aucun ADMIN_PASSWORD configuré (fail-closed). "
            "Configurer un mot de passe ou activer dev_open_admin en dev."
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "unauthorized",
                "message": "Authentification requise (aucun mot de passe admin configuré).",
            },
        )
    if not request.session.get("authenticated"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Authentification requise."},
        )
