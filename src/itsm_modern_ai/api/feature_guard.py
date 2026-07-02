"""Garde de feature Supporter — `require_feature(key)`.

Refuse (403 `feature_locked`) si la feature demandée n'est pas ACTIVE, c'est-à-dire si
son code n'est pas installé OU si la licence ne l'autorise pas.

Usage :

    from ..feature_guard import require_feature
    from ...domain.licensing import FEATURE_SCHEDULED_EXPORTS

    @router.post("/exports/schedule", dependencies=[Depends(require_feature(FEATURE_SCHEDULED_EXPORTS))])
    def schedule_export(...): ...
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException, Request, status

from ..services.license_service import LicenseService


def feature_is_active(request: Request, key: str) -> bool:
    """Vrai si la feature est installée (plugin présent) ET autorisée par la licence."""
    registry = getattr(request.app.state, "plugin_registry", None)
    installed = registry.installed_features() if registry is not None else frozenset()
    if key not in installed:
        return False
    from .deps import config_service_from_request

    with config_service_from_request(request) as cfg:
        return LicenseService(cfg).has_feature(key)


def require_feature(key: str) -> Callable[[Request], None]:
    """Fabrique une dépendance FastAPI qui exige que la feature `key` soit active."""

    def _guard(request: Request) -> None:
        if not feature_is_active(request, key):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "feature_locked",
                    "feature": key,
                    "message": "Fonctionnalité Supporter — licence requise pour la débloquer.",
                },
            )

    return _guard
