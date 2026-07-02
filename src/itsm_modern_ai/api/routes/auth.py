"""Authentification locale (FR-24) : login / logout par session cookie."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from ...services.runtime_config import RuntimeConfigService
from .. import security
from ..client_ip import client_ip
from ..deps import get_config_service

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str


class AuthStatus(BaseModel):
    authenticated: bool
    auth_configured: bool


def _client_key(request: Request) -> str:
    """Clé de rate-limit = IP du client (XFF respecté si `trust_proxy_headers=True`)."""
    settings = request.app.state.settings
    trust = bool(getattr(settings, "trust_proxy_headers", False))
    hops = int(getattr(settings, "trusted_proxy_hops", 1))
    return client_ip(request, trust, trusted_hops=hops)


@router.post("/login", response_model=AuthStatus)
def login(
    body: LoginRequest, request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> AuthStatus:
    limiter = request.app.state.login_limiter
    key = _client_key(request)

    # Anti brute-force : refuser tôt si la clé est bloquée (FR-24 durci).
    retry_after = limiter.retry_after(key)
    if retry_after is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "too_many_attempts", "message": "Trop de tentatives. Réessayez plus tard."},
            headers={"Retry-After": str(int(retry_after) + 1)},
        )

    if not security.verify_login(cfg, body.password):
        limiter.record_failure(key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "bad_credentials", "message": "Mot de passe incorrect."},
        )
    limiter.reset(key)  # succès : on efface le compteur d'échecs de cette IP
    request.session["authenticated"] = True
    return AuthStatus(authenticated=True, auth_configured=True)


@router.post("/logout", response_model=AuthStatus)
def logout(request: Request, cfg: RuntimeConfigService = Depends(get_config_service)) -> AuthStatus:
    request.session.pop("authenticated", None)
    return AuthStatus(authenticated=False, auth_configured=security.auth_is_configured(cfg))


@router.get("/status", response_model=AuthStatus)
def auth_status(
    request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> AuthStatus:
    # `authenticated` reflète les MÊMES règles d'accès que `require_auth` (session
    # active, ou admin ouvert via dev_open_admin) : le frontend peut s'y fier seul.
    # Sinon, en fail-closed sans mot de passe, « non configuré = ouvert » côté UI et
    # « non configuré = refusé » côté API se contredisent → boucle de redirection.
    return AuthStatus(
        authenticated=security.session_is_authenticated(request),
        auth_configured=security.auth_is_configured(cfg),
    )
