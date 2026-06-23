"""Endpoint licence (page Supporter) — édition active, features verrouillées/débloquées, saisie de clé.

Vérification 100 % hors-ligne (Ed25519). Protégé par l'auth locale (FR-24).

Une feature est :
- **installed** : son code est présent dans l'image (toujours vrai en édition unique) ;
- **entitled** : la licence l'autorise ;
- **active**  : installed ET entitled (seul cas où elle fonctionne réellement).

Sans licence valide, `entitled=False` partout → les features restent verrouillées
(« devenez Supporter »), même si le code est livré dans l'image.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ...domain.licensing import FEATURE_CATALOG, LicenseStatus
from ...services.license_service import LicenseService
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service
from ..security import require_auth

router = APIRouter(prefix="/api/license", tags=["license"], dependencies=[Depends(require_auth)])


class FeatureView(BaseModel):
    key: str
    label_fr: str
    label_en: str
    description_fr: str
    description_en: str
    installed: bool  # code présent dans l'image (toujours vrai en édition unique)
    entitled: bool  # autorisé par la licence
    active: bool  # installed ET entitled


class LicenseView(BaseModel):
    edition: str  # community | supporter
    valid: bool
    customer: str | None = None
    issued_at: str | None = None
    expires_at: str | None = None
    error: str | None = None
    features: list[FeatureView]


class LicenseUpdate(BaseModel):
    # Un jeton légitime fait quelques centaines d'octets ; on borne l'entrée pour éviter
    # un parse coûteux (b64 + json) d'un « jeton » multi-Mo (DoS), cohérent avec les
    # max_length du reste de l'API.
    key: str = Field(max_length=8192)


def _installed_keys(request: Request) -> frozenset[str]:
    registry = getattr(request.app.state, "plugin_registry", None)
    return registry.installed_features() if registry is not None else frozenset()


def _view_from_status(request: Request, status: LicenseStatus) -> LicenseView:
    installed_keys = _installed_keys(request)
    features = [
        FeatureView(
            key=spec.key,
            label_fr=spec.label_fr,
            label_en=spec.label_en,
            description_fr=spec.description_fr,
            description_en=spec.description_en,
            installed=spec.key in installed_keys,
            entitled=status.has_feature(spec.key),
            active=(spec.key in installed_keys) and status.has_feature(spec.key),
        )
        for spec in FEATURE_CATALOG
    ]
    return LicenseView(
        edition=status.edition,
        valid=status.valid,
        customer=status.customer,
        issued_at=status.issued_at.isoformat() if status.issued_at else None,
        expires_at=status.expires_at.isoformat() if status.expires_at else None,
        error=status.error,
        features=features,
    )


@router.get("", response_model=LicenseView)
def get_license(
    request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> LicenseView:
    return _view_from_status(request, LicenseService(cfg).status())


@router.post("", response_model=LicenseView)
def set_license(
    payload: LicenseUpdate,
    request: Request,
    cfg: RuntimeConfigService = Depends(get_config_service),
) -> LicenseView:
    # set_key valide d'abord : une clé invalide n'est PAS stockée, mais le statut
    # renvoyé porte l'erreur explicite (format/signature/expiration) pour l'UI.
    status = LicenseService(cfg).set_key(payload.key)
    return _view_from_status(request, status)


@router.delete("", response_model=LicenseView)
def delete_license(
    request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> LicenseView:
    svc = LicenseService(cfg)
    svc.clear()
    return _view_from_status(request, svc.status())
