"""Authentification locale (FR-24) — compte admin (email + mot de passe Argon2) + session.

Le compte administrateur est créé **dans l'interface, à la première visite** (POST
`/api/auth/setup`). Il n'y a plus AUCUN amorçage par variable d'environnement : ni
`ADMIN_PASSWORD` lu par `Settings`, ni `ITSM_ADMIN_PASSWORD` lu par la CLI. Le hash Argon2
est stocké chiffré (Fernet) en base ; l'email et le nom affiché vivent à côté, en clair
(ce ne sont pas des secrets) mais sous des clés RÉSERVÉES, donc hors `/api/config`.

⚠️ RISQUE ASSUMÉ, DÉLIBÉRÉ (décision du propriétaire du produit) : entre le démarrage du
conteneur et la création du compte, quiconque atteint le port peut revendiquer
l'administration. Ni jeton d'amorçage ni fenêtre temporelle ne sont posés — le prix serait
un secret à transporter, c'est-à-dire exactement ce qu'on vient de supprimer. La seule
contre-mesure retenue est de le DIRE, fort et à chaque démarrage : cf.
`warn_if_setup_required`, appelé par le lifespan de `api/app.py`.

FAIL-CLOSED (durcissement audit 2026-05) : tant qu'aucun compte n'existe, les endpoints
d'admin sont REFUSÉS (401). L'ancien comportement « ouvert » (pilote réseau interne) doit
être activé EXPLICITEMENT via `settings.dev_open_admin`.
2FA TOTP : non implémenté (OFF par défaut, PRD).
"""

from __future__ import annotations

import logging
import re
import secrets as _secrets
from hmac import compare_digest

from fastapi import HTTPException, Request, status
from pwdlib import PasswordHash

from ..domain.errors import SecretDecryptError
from ..services.runtime_config import RuntimeConfigService

logger = logging.getLogger("itsm.security")
_hasher = PasswordHash.recommended()  # Argon2

HASH_KEY = "admin_password_hash"

# Longueur minimale du mot de passe admin — source de vérité UNIQUE (audit 2026-08).
# Elle vivait dans `admin_setup.MIN_LEN` et n'était donc appliquée QUE par la CLI ; l'amorçage
# paresseux par variable d'environnement hashait `ADMIN_PASSWORD` sans aucun contrôle (mot de
# passe d'UN caractère accepté par la première requête HTTP). Cet amorçage a disparu, mais le
# minimum reste porté par le module d'authentification : `admin_setup` et la route
# `/api/auth/setup` le réimportent tous deux, et le frontend en recopie la valeur
# (`MIN_PASSWORD_CHARS`, `frontend/src/lib/api.ts`).
#
# ⚠️ NE PAS REBAPTISER cette constante avec un nom contenant `PASSWORD`, `SECRET`,
# `CREDENTIAL` ou `TOKEN` — si évident que cela paraisse. Elle s'appelait `MIN_PASSWORD_LEN`
# et déclenchait à ce titre deux alertes CodeQL `high` — `py/clear-text-logging-sensitive-data`.
# La requête classe les données sensibles par le NOM de l'identifiant (regex `password`,
# `secret`, `credential`…), sans jamais regarder la valeur : un entier littéral valant 8,
# journalisé pour indiquer à l'admin le minimum exigé, était rapporté comme « mot de passe
# en clair dans les logs ». Faux positif, mais qui noie les vraies alertes.
MIN_ADMIN_CHARS = 8

# Longueur maximale d'une adresse (RFC 5321 : 254 caractères pour un chemin de retour).
EMAIL_MAX_CHARS = 254
# Nom affiché : borné pour ne pas laisser écrire un roman dans une clé de config.
DISPLAY_NAME_MAX_CHARS = 200

# Format d'email VOLONTAIREMENT permissif — même règle que le formulaire
# (`frontend/src/pages/Setup.tsx`). Valider finement une adresse est un piège connu
# (RFC 5322 accepte des formes que personne n'écrit) et n'apporte rien ici : cette adresse
# n'est pas un canal d'envoi, c'est un IDENTIFIANT de connexion. On refuse seulement ce qui
# ne peut pas en être un.
#
# Le point est EXCLU des classes du domaine, et les étiquettes sont répétées explicitement.
# La forme naïve `[^\s@]+\.[^\s@]+` laissait le point appartenir aux deux côtés du `\.` :
# sur une adresse qui ne matche pas, le moteur devait essayer chaque découpage possible,
# soit un coût quadratique en la longueur de la saisie (CodeQL `py/polynomial-redos`).
# Ici les classes sont disjointes du séparateur, donc chaque caractère n'a qu'une lecture
# possible : le coût redevient linéaire, sans retour arrière.
#
# La borne de longueur ci-dessus plafonnait déjà les dégâts à 254 caractères — mais elle
# n'est pas une réponse : elle rend l'attaque non rentable, elle ne rend pas le motif sain.
#
# Effet de bord assumé : `a@b..c` et `a@b.` sont désormais refusés. Aucune des deux n'est
# une adresse, et aucune ne pouvait servir d'identifiant de connexion utilisable.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$")

# Clé du champ de session portant la GÉNÉRATION de la session (cf.
# `RuntimeConfigService.session_version`). Nom court : il transite dans le cookie signé.
SESSION_VERSION_FIELD = "sv"

# Hash « à vide » servant à faire payer la MÊME vérification Argon2 quand aucun compte
# n'existe ou que l'email ne correspond pas (cf. `verify_login`). Construit à la demande :
# un hash Argon2 coûte ~50 ms, hors de question de le payer à l'import d'un module chargé
# par la CLI et par les tests.
_dummy_hash_cache: str | None = None


def hash_password(plaintext: str) -> str:
    return _hasher.hash(plaintext)


def normalize_email(raw: str | None) -> str:
    """Forme canonique d'une adresse : sans espaces de bord, en minuscules.

    La comparaison de connexion se fait sur cette forme — « Admin@Exemple.fr » et
    « admin@exemple.fr  » sont le même compte, sinon l'admin se retrouve enfermé dehors
    par une majuscule de saisie automatique du navigateur.
    """
    return (raw or "").strip().lower()


def email_is_valid(email: str) -> bool:
    return bool(email) and len(email) <= EMAIL_MAX_CHARS and _EMAIL_RE.match(email) is not None


def _dummy_hash() -> str:
    global _dummy_hash_cache
    if _dummy_hash_cache is None:
        _dummy_hash_cache = _hasher.hash(_secrets.token_urlsafe(32))
    return _dummy_hash_cache


def stored_hash(cfg: RuntimeConfigService) -> str | None:
    """Hash admin courant, ou None si aucun compte n'est configuré.

    Fail-safe (audit 2026-05) : si le hash stocké est illisible (MASTER_KEY incohérente),
    on NE crashe PAS en 500 — on traite le compte comme absent (→ fail-closed 401 clair),
    ce qui évite de verrouiller le login derrière une erreur serveur opaque.
    """
    try:
        return cfg.get_secret(HASH_KEY) or None
    except SecretDecryptError:
        logger.error(
            "hash admin illisible (MASTER_KEY incohérente) — login impossible jusqu'à "
            "reconfiguration du compte admin. Vérifiez MASTER_KEY / data/master.key, ou "
            "rejouez `python -m itsm_modern_ai.admin_setup --force --email <adresse>`."
        )
        return None


def auth_is_configured(cfg: RuntimeConfigService) -> bool:
    return stored_hash(cfg) is not None


def warn_if_setup_required(cfg: RuntimeConfigService) -> bool:
    """Journalise BRUYAMMENT tant qu'aucun compte administrateur n'existe. Renvoie l'état.

    Appelé au démarrage (lifespan). C'est la contrepartie assumée du choix de créer le
    compte à la première visite SANS jeton d'amorçage : la fenêtre de revendication est
    réelle, elle n'est ni fermée ni masquée — elle est annoncée, à chaque démarrage, tant
    qu'elle est ouverte. Un exploitant qui lit ses logs (ou son agrégateur) voit donc
    l'instance réclamer d'être revendiquée, et sait qu'il ne doit pas l'exposer avant.
    """
    if auth_is_configured(cfg):
        return False
    logger.warning(
        "AUCUN COMPTE ADMINISTRATEUR : cette instance est REVENDICABLE. La premiere "
        "personne qui atteint ce port peut creer le compte administrateur (POST "
        "/api/auth/setup) et prendre le controle du moteur. N'EXPOSEZ PAS ce port "
        "publiquement avant d'avoir cree le compte : ouvrez l'interface et suivez l'ecran "
        "d'installation. Cet avertissement disparaitra une fois le compte cree."
    )
    return True


def verify_login(cfg: RuntimeConfigService, email: str, password: str) -> bool:
    """Vrai si (email, mot de passe) correspondent au compte administrateur.

    ⚠️ Deux propriétés à ne pas casser :
    1. **aucune distinction** entre « email inconnu » et « mot de passe faux ». L'appelant
       renvoie le même code et le même message dans les deux cas ;
    2. le hash est vérifié **dans tous les cas**, y compris quand l'email ne correspond pas
       ou qu'aucun compte n'existe (hash factice). Sans ça, un refus immédiat contre ~50 ms
       d'Argon2 suffirait à énumérer les adresses valides au chronomètre — le canal temporel
       rendrait la propriété 1 purement cosmétique.
    """
    current = stored_hash(cfg)
    registered = cfg.admin_email() or ""
    try:
        password_ok = _hasher.verify(password, current or _dummy_hash())
    except Exception:
        # Hash déchiffrable mais illisible (format inconnu, valeur tronquée) : refus net,
        # jamais une 500 qui verrouillerait la console derrière une trace opaque.
        password_ok = False
    # Comparaison sur les OCTETS : `compare_digest` refuse (TypeError) une `str` non-ASCII,
    # et une adresse accentuée est parfaitement saisissable dans le formulaire.
    email_ok = bool(registered) and compare_digest(
        normalize_email(email).encode("utf-8"), registered.encode("utf-8")
    )
    return bool(current) and password_ok and email_ok


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
    quand aucun compte n'est configuré), mais en simple prédicat.

    Durcissement : on NE se fie PAS au seul cookie. Si l'admin n'est pas configuré, un cookie
    résiduel ne vaut « authentifié » que sous `dev_open_admin` (fail-closed sinon), exactement
    comme `require_auth` — sinon un cookie orphelin ouvrirait une instance sans compte.
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

    FAIL-CLOSED : si aucun compte administrateur n'est configuré, l'accès est REFUSÉ (401)
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
                "accès admin OUVERT sans compte administrateur (dev_open_admin=true) — "
                "ne JAMAIS utiliser en prod"
            )
            return
        # Fail-closed : pas de compte + pas d'ouverture explicite → refus.
        logger.warning(
            "accès admin refusé : aucun compte administrateur créé (fail-closed). "
            "Ouvrir l'interface pour créer le compte, ou activer dev_open_admin en dev."
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "unauthorized",
                "message": "Authentification requise (aucun compte administrateur créé).",
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
