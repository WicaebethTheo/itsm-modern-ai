"""Aperçu GLPI pour l'UI : sous quel compte le bot agit-il (legacy ou V2) + sa photo.

Interroge GLPI en live (best-effort) pour afficher le compte effectif côté console —
utile pour vérifier d'un coup d'œil que les identifiants pointent sur le bon compte
technique. Protégé par l'auth locale (FR-24).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service
from ..runtime import build_connector
from ..security import require_auth

router = APIRouter(prefix="/api/glpi", tags=["glpi"], dependencies=[Depends(require_auth)])

# Clés de connexion GLPI effacées par /reset (legacy + V2). Les secrets via set_secret.
_RESET_PLAIN = (
    "glpi_base_url", "glpi_v2_base_url", "glpi_api_version",
    "glpi_oauth_client_id", "glpi_oauth_username", "glpi_oauth_scope",
    "glpi_verify_tls", "glpi_followup_legacy_9x",
)
_RESET_SECRET = (
    "glpi_user_token", "glpi_app_token", "glpi_oauth_client_secret", "glpi_oauth_password",
)


class GlpiAccount(BaseModel):
    api_version: str  # legacy | v2
    configured: bool  # un connecteur a-t-il pu être construit (identifiants présents) ?
    account: str | None = None  # nom affichable du compte, None si indéterminé/injoignable
    username: str = ""
    profile: str = ""  # profil/rôle GLPI actif
    email: str = ""
    has_picture: bool = False  # une photo est-elle récupérable via /api/glpi/avatar ?


@router.get("/whoami", response_model=GlpiAccount)
async def whoami(
    request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> GlpiAccount:
    api_version = (cfg.get("glpi_api_version") or "legacy").strip().lower()
    connector = build_connector(request.app.state.settings, request.app.state.secrets_box)
    if connector is None:
        return GlpiAccount(api_version=api_version, configured=False)
    ident = await connector.whoami()
    if ident is None:
        return GlpiAccount(api_version=api_version, configured=True)
    return GlpiAccount(
        api_version=api_version,
        configured=True,
        account=ident.account,
        username=ident.username,
        profile=ident.profile,
        email=ident.email,
        has_picture=ident.has_picture,
    )


@router.post("/reset")
def reset(cfg: RuntimeConfigService = Depends(get_config_service)) -> dict:
    """Réinitialise TOUTE la connexion GLPI (legacy + V2) : URLs, tokens, identifiants OAuth.

    Remet les réglages non-secrets à vide (→ valeurs par défaut, api_version repasse à
    `legacy`) et efface les secrets. Permet de repartir d'une config GLPI propre depuis l'UI.
    """
    for k in _RESET_PLAIN:
        cfg.set(k, "")
    for k in _RESET_SECRET:
        cfg.set_secret(k, "")
    return {"ok": True}


@router.get("/avatar")
async def avatar(request: Request) -> Response:
    """Photo de profil du compte bot (proxy GLPI). 404 si indisponible (UI → initiales)."""
    connector = build_connector(request.app.state.settings, request.app.state.secrets_box)
    pic = await connector.avatar() if connector is not None else None
    if pic is None:
        raise HTTPException(status_code=404, detail={"code": "no_picture"})
    content, content_type = pic
    # Cache court : la photo change rarement, évite un aller-retour GLPI à chaque rendu.
    return Response(content=content, media_type=content_type, headers={"Cache-Control": "private, max-age=300"})
