"""Authentification locale (FR-24) : création du compte, login / logout par cookie.

Trois routes publiques, un seul compte administrateur :
- `GET  /api/auth/status` — état, dont `setup_required` (aucun compte → écran d'installation) ;
- `POST /api/auth/setup`  — création du compte à la PREMIÈRE visite (fail-closed : 409 si un
  compte existe déjà). Ouvre la session dans la foulée ;
- `POST /api/auth/login`  — email + mot de passe.

⚠️ L'adresse du compte n'apparaît sur AUCUNE de ces réponses : `/api/auth/status` est
public, et diffuser l'identifiant à un anonyme lui offrirait la moitié du couple à deviner.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from ...admin_setup import AdminSetupError, set_admin_password
from ...services.runtime_config import RuntimeConfigService
from .. import security
from ..client_ip import client_ip
from ..deps import get_config_service

logger = logging.getLogger("itsm.security")

router = APIRouter(prefix="/api/auth", tags=["auth"])

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
