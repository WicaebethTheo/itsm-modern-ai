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

# Longueur minimale du mot de passe admin — source de vérité UNIQUE (audit 2026-08).
# Elle vivait dans `admin_setup.MIN_LEN` et n'était donc appliquée QUE par la CLI ; l'amorçage
# paresseux ci-dessous (`_ensure_bootstrapped`) hashait `ADMIN_PASSWORD` sans aucun contrôle.
# Résultat mesuré : un mot de passe d'UN caractère refusé par `admin_setup` était accepté par
# la première requête HTTP — `docker/entrypoint.sh` logue « démarrage quand même » après
# l'échec de la CLI, et l'amorçage paresseux reprenait la main. Le minimum est désormais
# porté par le module d'authentification lui-même, et `admin_setup` le réimporte.
MIN_PASSWORD_LEN = 8

# Clé du champ de session portant la GÉNÉRATION de la session (cf.
# `RuntimeConfigService.session_version`). Nom court : il transite dans le cookie signé.
SESSION_VERSION_FIELD = "sv"


def hash_password(plaintext: str) -> str:
    return _hasher.hash(plaintext)


def _ensure_bootstrapped(cfg: RuntimeConfigService) -> str | None:
    """Renvoie le hash admin courant, en l'amorçant depuis l'env si nécessaire.

    Fail-safe (audit 2026-05) : si le hash stocké est illisible (MASTER_KEY incohérente),
    on NE crashe PAS en 500 — on traite l'admin comme non amorcé (→ fail-closed 401 clair),
    ce qui évite de verrouiller le login derrière une erreur serveur opaque.

    Politique de mot de passe (audit 2026-08) : l'amorçage depuis `ADMIN_PASSWORD` applique
    le MÊME minimum que `admin_setup` (`MIN_PASSWORD_LEN`). Un mot de passe trop court est
    REFUSÉ (log ERROR explicite + admin laissé non configuré) : le fail-closed déjà en place
    prend alors le relais et refuse l'accès, au lieu d'ouvrir la console derrière un secret
    d'un caractère que la CLI avait justement rejeté.
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
        if len(bootstrap) < MIN_PASSWORD_LEN:
            # ⚠️ NE JAMAIS journaliser la longueur du mot de passe refusé (CodeQL
            # `py/clear-text-logging-sensitive-data`). Ce n'était pas la valeur, mais la
            # longueur est déjà un renseignement : elle réduit l'espace de recherche d'une
            # force brute, et un log part souvent vers un agrégateur dont le périmètre
            # d'accès est bien plus large que celui du `.env`. Elle n'a en outre aucune
            # valeur opérationnelle : l'administrateur connaît son propre mot de passe ;
            # ce qu'il lui faut, c'est le minimum exigé et la marche à suivre.
            logger.error(
                "ADMIN_PASSWORD REFUSÉ : trop court (minimum %d caractères). "
                "Le compte administrateur reste NON configuré (accès refusé, fail-closed). "
                "Définissez un mot de passe d'au moins %d caractères "
                "(ITSM_ADMIN_PASSWORD / `python -m itsm_modern_ai.admin_setup`).",
                MIN_PASSWORD_LEN, MIN_PASSWORD_LEN,
            )
            return None
        h = hash_password(bootstrap)
        cfg.set_secret(HASH_KEY, h)
        # Tout changement de mot de passe invalide les sessions déjà émises : un cookie
        # obtenu avant l'amorçage ne doit pas survivre à la mise sous mot de passe.
        cfg.bump_session_version()
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


def start_session(request: Request, cfg: RuntimeConfigService) -> None:
    """Marque la session comme authentifiée, en y gravant la génération courante.

    Le cookie ne portait que `{"authenticated": True}` : sans identifiant NI génération, il
    restait valide après le logout ET après un changement de mot de passe (rejeu mesuré →
    200). On y ajoute la version de session : elle est comparée à celle de la base à chaque
    requête, ce qui rend la révocation possible sans changer `MASTER_KEY` (opération qui
    rendrait illisibles TOUS les secrets et verrouillerait la console).
    """
    request.session["authenticated"] = True
    request.session[SESSION_VERSION_FIELD] = cfg.session_version()


def revoke_sessions(cfg: RuntimeConfigService) -> None:
    """Invalide TOUS les cookies de session déjà émis (logout, rotation de mot de passe)."""
    cfg.bump_session_version()


def _session_is_current(request: Request, cfg: RuntimeConfigService) -> bool:
    """Vrai si le cookie porte une session active ET de la génération COURANTE.

    Fail-closed : un cookie sans champ de génération (émis avant ce durcissement, ou forgé)
    ne vaut que si la base est encore à la génération 0 — dès la première révocation, il est
    rejeté comme tous les autres.
    """
    if not request.session.get("authenticated"):
        return False
    return request.session.get(SESSION_VERSION_FIELD, 0) == cfg.session_version()


def session_is_authenticated(request: Request) -> bool:
    """Vrai si la requête porte une session admin valide — SANS lever de 401.

    Sert aux endpoints publics à réponse « enrichie si authentifié » (ex. /api/status) :
    mêmes règles que `require_auth` (session active, ou admin ouvert via `dev_open_admin`
    quand aucun mot de passe n'est configuré), mais en simple prédicat.

    Durcissement : on NE se fie PAS au seul cookie. Si l'admin n'est pas configuré, un cookie
    résiduel ne vaut « authentifié » que sous `dev_open_admin` (fail-closed sinon), exactement
    comme `require_auth` — sinon un cookie orphelin ouvrirait une instance sans mot de passe.
    """
    from .deps import config_service_from_request

    with config_service_from_request(request) as cfg:
        configured = auth_is_configured(cfg)
        dev_open = bool(getattr(cfg.settings, "dev_open_admin", False))
        # Génération lue DANS la même session DB : un cookie révoqué (logout, changement de
        # mot de passe) ne doit plus valoir « authentifié » nulle part.
        current = _session_is_current(request, cfg)
    if not configured:
        return dev_open
    return current


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
        current = _session_is_current(request, cfg)
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
    if not current:
        # Couvre les deux cas : aucune session, ou session RÉVOQUÉE (logout / changement
        # de mot de passe). Message unique — inutile d'indiquer à un porteur de cookie
        # périmé pourquoi exactement il est refusé.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Authentification requise."},
        )
