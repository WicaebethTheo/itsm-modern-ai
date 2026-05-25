"""Authentification locale (FR-24) : login / logout par session cookie."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from ...services.runtime_config import RuntimeConfigService
from .. import security
from ..deps import get_config_service

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str


class AuthStatus(BaseModel):
    authenticated: bool
    auth_configured: bool


@router.post("/login", response_model=AuthStatus)
def login(
    body: LoginRequest, request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> AuthStatus:
    if not security.verify_login(cfg, body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "bad_credentials", "message": "Mot de passe incorrect."},
        )
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
    return AuthStatus(
        authenticated=bool(request.session.get("authenticated")),
        auth_configured=security.auth_is_configured(cfg),
    )
