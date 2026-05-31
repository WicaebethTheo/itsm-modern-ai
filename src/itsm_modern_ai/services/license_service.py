"""Service de licence — pont entre la config runtime (clé saisie via l'UI) et la
vérification hors-ligne du domaine (`domain.licensing`).

La clé de licence est un réglage non-secret surchargeable (`license_key`) : elle est
signée et auto-portante, donc inutile de la chiffrer. Aucun appel réseau.
"""

from __future__ import annotations

from datetime import UTC, datetime

from ..domain.licensing import COMMUNITY_STATUS, LicenseStatus, verify_license
from .runtime_config import RuntimeConfigService

LICENSE_KEY = "license_key"


class LicenseService:
    def __init__(self, cfg: RuntimeConfigService) -> None:
        self._cfg = cfg

    def status(self) -> LicenseStatus:
        token = self._cfg.get(LICENSE_KEY) or ""
        if not token:
            return COMMUNITY_STATUS
        return verify_license(token, today=datetime.now(UTC).date())

    def set_key(self, token: str) -> LicenseStatus:
        """Enregistre la clé (après validation). Renvoie le statut résultant.

        Refuse une clé invalide pour ne pas stocker un jeton inutile.
        """
        token = (token or "").strip()
        result = verify_license(token, today=datetime.now(UTC).date())
        if not result.valid:
            return result
        self._cfg.set(LICENSE_KEY, token)
        return result

    def clear(self) -> None:
        self._cfg.set(LICENSE_KEY, "")

    def has_feature(self, key: str) -> bool:
        return self.status().has_feature(key)
