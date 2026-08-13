"""Authentification locale (FR-24) : création du compte, login / logout par cookie.

Trois routes publiques, un seul compte administrateur :
- `GET  /api/auth/status` — état, dont `setup_required` (aucun compte → écran d'installation) ;
- `POST /api/auth/setup`  — création du compte à la PREMIÈRE visite (fail-closed : 409 si un
  compte existe déjà). Ouvre la session dans la foulée ;
- `POST /api/auth/login`  — email + mot de passe.

… et deux routes AUTHENTIFIÉES, pour la page « Compte & sécurité » de la console :
- `GET  /api/auth/me`       — identité du compte connecté (email + nom affiché) ;
- `POST /api/auth/password` — rotation du mot de passe (mot de passe courant exigé).

⚠️ L'adresse du compte n'apparaît sur AUCUNE des réponses PUBLIQUES : `/api/auth/status`
est public, et diffuser l'identifiant à un anonyme lui offrirait la moitié du couple à
deviner. C'est précisément pourquoi `me` est une route SÉPARÉE et gardée, et non un champ
de plus dans `AuthStatus` — la tentation de fusionner les deux reviendra, il faut la
refuser (test de non-régression : `test_l_email_n_apparait_sur_aucune_reponse_publique`).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from ...admin_setup import AdminSetupError, set_admin_password
from ...services.runtime_config import RuntimeConfigService
from .. import security
from ..client_ip import client_ip
from ..deps import get_config_service

logger = logging.getLogger("itsm.security")


def _no_store(response: Response) -> None:
    """Interdit la CONSERVATION des réponses d'authentification (`Cache-Control: no-store`).

    `GET /api/auth/me` est la seule route du produit qui porte l'adresse du compte.
    `Vary: Cookie` empêchait déjà un cache PARTAGÉ de la servir à un anonyme, mais rien
    n'interdisait de l'écrire sur disque (cache navigateur, proxy d'entreprise) : l'identité
    de l'administrateur survivait alors à la session qui l'avait obtenue.

    Posé sur TOUT le préfixe, et non sur la seule route concernée : aucune réponse
    d'authentification (statut, création, connexion, rotation) n'a de raison d'être
    conservée, et l'oubli du jour où une route s'ajoutera coûterait plus cher que l'en-tête.
    """
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/api/auth", tags=["auth"], dependencies=[Depends(_no_store)])

# Bornes de saisie : rien de fonctionnel, juste de quoi ne pas hasher un mégaoctet ni
# stocker un roman. La politique réelle (longueur MINIMALE, format d'email) vit dans
# `api/security.py` et `admin_setup.set_admin_password`, source de vérité unique.
EMAIL_INPUT_MAX = 320
PASSWORD_INPUT_MAX = 1024


class LoginRequest(BaseModel):
    email: str = Field(default="", max_length=EMAIL_INPUT_MAX)
    password: str = Field(max_length=PASSWORD_INPUT_MAX)


class SetupRequest(BaseModel):
    email: str = Field(max_length=EMAIL_INPUT_MAX)
    password: str = Field(max_length=PASSWORD_INPUT_MAX)
    display_name: str | None = Field(default=None, max_length=security.DISPLAY_NAME_MAX_CHARS)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(max_length=PASSWORD_INPUT_MAX)
    new_password: str = Field(max_length=PASSWORD_INPUT_MAX)


class AdminIdentity(BaseModel):
    """Identité du compte connecté — servie UNIQUEMENT derrière `require_auth`."""

    email: str
    display_name: str | None = None


class PasswordChanged(BaseModel):
    ok: bool = True


class AuthStatus(BaseModel):
    authenticated: bool
    auth_configured: bool
    # Aucun compte administrateur → l'installation n'est pas terminée et l'UI doit envoyer
    # sur l'écran de création. Volontairement dérivé de `auth_configured` (et non d'un
    # troisième état stocké) : deux sources de vérité finiraient par diverger.
    setup_required: bool = False


def _client_key(request: Request) -> str:
    """Clé de rate-limit = IP du client (XFF respecté si `trust_proxy_headers=True`)."""
    settings = request.app.state.settings
    trust = bool(getattr(settings, "trust_proxy_headers", False))
    hops = int(getattr(settings, "trusted_proxy_hops", 1))
    return client_ip(request, trust, trusted_hops=hops)


def _password_key(key: str) -> str:
    """Sous-clé de rate-limit PROPRE à `/api/auth/password`, dérivée de la clé IP.

    Les échecs de la rotation restent comptés sur la clé PARTAGÉE (`/login`, `/setup`) :
    cette route dit « oui / non » sur un mot de passe, c'est un oracle de vérification, et
    ne pas l'y compter rouvrirait un canal de force brute parallèle.

    Mais le PRÉ-CONTRÔLE, lui, se fait sur cette sous-clé, alimentée uniquement par les
    échecs de la rotation elle-même. Sinon un tiers qui martèle `/api/auth/login` — route
    PUBLIQUE — interdirait à l'admin déjà authentifié de changer son mot de passe ; et
    derrière un reverse proxy sans `trust_proxy_headers`, tout le monde partage une seule
    clé IP, donc n'importe quel visiteur suffirait. Or la rotation est précisément ce qu'on
    déclenche quand on soupçonne un cookie volé : la fermer à l'admin sur une nuisance
    anonyme, c'est convertir un déni de service en perte de contrôle du compte.
    """
    return f"password:{key}"


def _reject_if_rate_limited(request: Request, key: str) -> None:
    """Anti brute-force : refuse tôt si la clé est bloquée (FR-24 durci).

    Partagé par `login` ET `setup` : la création du compte est publique et non
    authentifiée, elle offrirait sinon un point de martèlement NON compté — et, en prime,
    un moyen de sonder gratuitement si l'instance est encore revendicable.
    """
    retry_after = request.app.state.login_limiter.retry_after(key)
    if retry_after is None:
        return
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={"code": "too_many_attempts", "message": "Trop de tentatives. Réessayez plus tard."},
        headers={"Retry-After": str(int(retry_after) + 1)},
    )


@router.post("/setup", response_model=AuthStatus)
def setup(
    body: SetupRequest, request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> AuthStatus:
    """Crée le compte administrateur UNIQUE, puis connecte immédiatement.

    Route PUBLIQUE — c'est le tout premier écran du produit, il n'y a par construction
    aucun identifiant pour l'atteindre — mais FAIL-CLOSED : dès qu'un hash existe, elle
    refuse (409) sans rien toucher au compte en place. La fenêtre de revendication entre le
    démarrage et cette création est un risque ASSUMÉ, annoncé à chaque démarrage
    (`security.warn_if_setup_required`).
    """
    limiter = request.app.state.login_limiter
    key = _client_key(request)
    _reject_if_rate_limited(request, key)

    try:
        set_admin_password(
            cfg, body.password, email=body.email, display_name=body.display_name, force=False
        )
    except AdminSetupError as exc:
        limiter.record_failure(key)
        code = status.HTTP_409_CONFLICT if exc.code == "already_configured" else 422
        raise HTTPException(
            status_code=code, detail={"code": exc.code, "message": str(exc)}
        ) from exc
    except IntegrityError as exc:
        # MÊME CONFLIT, vu de l'autre côté. `set_admin_password` teste l'existence du hash
        # PUIS l'écrit, sans transaction couvrant les deux : deux `POST /api/auth/setup`
        # concurrents passent tous les deux le test, et le perdant heurte la clé primaire de
        # `runtime_config`. La barrière tient donc — il n'y a jamais deux comptes, et aucun
        # écrasement silencieux — mais l'appelant recevait un 500 opaque là où le contrat de
        # l'API promet un 409 `already_configured`. C'est le même refus, il doit se lire
        # pareil. Le front s'appuie dessus (`Setup.tsx` renvoie vers la connexion sur 409).
        limiter.record_failure(key)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "already_configured",
                "message": "Un compte administrateur est déjà configuré sur ce moteur.",
            },
        ) from exc

    limiter.reset(key)
    # Session ouverte APRÈS `set_admin_password` : celui-ci révoque les générations
    # antérieures, un cookie posé avant serait donc mort-né.
    security.start_session(request, cfg)
    # Trace d'exploitation : c'est l'instant où l'instance cesse d'être revendicable, et
    # l'IP est le seul élément d'imputabilité disponible pour un compte qui n'existait pas
    # encore. WARNING assumé : cette ligne doit se voir dans un journal de démarrage.
    logger.warning(
        "compte administrateur CRÉÉ depuis %s — l'instance n'est plus revendicable", key
    )
    return AuthStatus(authenticated=True, auth_configured=True, setup_required=False)


@router.post("/login", response_model=AuthStatus)
def login(
    body: LoginRequest, request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> AuthStatus:
    limiter = request.app.state.login_limiter
    key = _client_key(request)
    _reject_if_rate_limited(request, key)

    if not security.verify_login(cfg, body.email, body.password):
        limiter.record_failure(key)
        # ⚠️ MÊME code et MÊME message que l'email soit inconnu ou le mot de passe faux :
        # distinguer les deux transformerait cette route en oracle d'énumération des
        # comptes. `verify_login` paie de son côté le hash dans TOUS les cas, pour que le
        # chronomètre ne dise pas non plus ce que le message tait.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "bad_credentials", "message": "Identifiants incorrects."},
        )
    limiter.reset(key)  # succès : on efface le compteur d'échecs de cette IP
    # La session porte la GÉNÉRATION courante (et non un simple booléen) : c'est ce qui
    # permet de la révoquer plus tard (logout, rotation du mot de passe).
    security.start_session(request, cfg)
    return AuthStatus(authenticated=True, auth_configured=True, setup_required=False)


@router.post("/logout", response_model=AuthStatus)
def logout(request: Request, cfg: RuntimeConfigService = Depends(get_config_service)) -> AuthStatus:
    # Vider le cookie côté client ne suffisait pas : un cookie signé déjà exfiltré restait
    # accepté indéfiniment (rejeu post-logout mesuré → 200). On incrémente donc la génération
    # de session, ce qui invalide côté SERVEUR tous les cookies émis — la seule parade
    # restante était de changer MASTER_KEY, au prix de tous les secrets chiffrés.
    #
    # ⚠️ UNIQUEMENT si l'appelant portait bien une session : `/api/auth/logout` est un
    # endpoint PUBLIC (pas de `require_auth`). Révoquer inconditionnellement offrirait à
    # n'importe qui sur le réseau un déni de service trivial — marteler ce POST déconnecterait
    # l'admin en boucle. Un porteur de cookie périmé ne révoque donc rien.
    if request.session.get("authenticated"):
        security.revoke_sessions(cfg)
    request.session.pop("authenticated", None)
    request.session.pop(security.SESSION_VERSION_FIELD, None)
    configured = security.auth_is_configured(cfg)
    return AuthStatus(
        authenticated=False, auth_configured=configured, setup_required=not configured
    )


@router.get("/status", response_model=AuthStatus)
def auth_status(
    request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> AuthStatus:
    # `authenticated` reflète les MÊMES règles d'accès que `require_auth` (session
    # active, ou admin ouvert via dev_open_admin) : le frontend peut s'y fier seul.
    # Sinon, en fail-closed sans compte, « non configuré = ouvert » côté UI et
    # « non configuré = refusé » côté API se contredisent → boucle de redirection.
    configured = security.auth_is_configured(cfg)
    return AuthStatus(
        authenticated=security.session_is_authenticated(request),
        auth_configured=configured,
        setup_required=not configured,
    )


@router.get("/me", response_model=AdminIdentity, dependencies=[Depends(security.require_auth)])
def me(cfg: RuntimeConfigService = Depends(get_config_service)) -> AdminIdentity:
    """Identité du compte connecté, pour l'en-tête de la console et « Compte & sécurité ».

    Route à part, et gardée : l'adresse est la moitié des identifiants. La faire remonter
    par `/api/auth/status` (publique) l'offrirait à n'importe quel anonyme atteignant le
    port — cf. la docstring en tête de module.
    """
    return AdminIdentity(
        email=cfg.admin_email() or "", display_name=cfg.admin_display_name() or None
    )


@router.post(
    "/password", response_model=PasswordChanged, dependencies=[Depends(security.require_auth)]
)
def change_password(
    body: PasswordChangeRequest,
    request: Request,
    cfg: RuntimeConfigService = Depends(get_config_service),
) -> PasswordChanged:
    """Rotation du mot de passe administrateur depuis la console.

    Deux garde-fous, aucun des deux n'est décoratif :

    1. **le mot de passe courant est REVÉRIFIÉ** (`verify_login`), même si l'appelant porte
       une session valide : sans ça, un cookie volé — ou un onglet laissé ouvert — suffirait
       à s'approprier définitivement le compte ;
    2. **le MÊME limiteur que `/login`, à la MÊME clé IP, POUR COMPTER.** Cette route dit
       « oui / non » sur un mot de passe : c'est un oracle de vérification, exactement comme
       le login. Non comptée, elle offrirait un canal de force brute qui contourne le
       limiteur de `/login`. Le PRÉ-CONTRÔLE, lui, lit une sous-clé propre à la route
       (`_password_key`) : la porte d'entrée du compteur partagé est publique, s'y fier
       pour REFUSER laisserait un anonyme verrouiller la rotation (cf. `_password_key`).

    ⚠️ EFFET VOULU : `set_admin_password` incrémente la génération de session, donc TOUTES
    les sessions tombent — y compris CELLE DE L'APPELANT. C'est le prix (assumé) de la
    révocation d'un cookie éventuellement volé ; le frontend renvoie vers `/login` après un
    succès et l'annonce à l'admin avant qu'il valide.
    """
    limiter = request.app.state.login_limiter
    key = _client_key(request)
    cle_rotation = _password_key(key)
    _reject_if_rate_limited(request, cle_rotation)

    # L'email n'est pas demandé au formulaire : le compte est UNIQUE, celui de la session.
    if not security.verify_login(cfg, cfg.admin_email() or "", body.current_password):
        # Les DEUX clés : la partagée pour que l'oracle continue de bloquer `/login`, la
        # sous-clé pour que le martèlement de CETTE route finisse par la fermer aussi.
        limiter.record_failure(key)
        limiter.record_failure(cle_rotation)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "bad_credentials", "message": "Mot de passe actuel incorrect."},
        )
    limiter.reset(key)
    limiter.reset(cle_rotation)

    try:
        # `force=True` : un compte existe forcément ici (require_auth l'a établi). L'email et
        # le nom affiché ne sont PAS touchés — cette route ne change qu'un secret.
        set_admin_password(cfg, body.new_password, force=True)
    except AdminSetupError as exc:
        raise HTTPException(
            status_code=422, detail={"code": exc.code, "message": str(exc)}
        ) from exc

    # Le cookie de l'appelant est désormais d'une génération périmée ; on le vide aussi côté
    # client pour ne pas laisser traîner un jeton qui ne vaut plus rien.
    request.session.pop("authenticated", None)
    request.session.pop(security.SESSION_VERSION_FIELD, None)
    logger.warning("mot de passe administrateur CHANGÉ depuis %s — sessions révoquées", key)
    return PasswordChanged()
