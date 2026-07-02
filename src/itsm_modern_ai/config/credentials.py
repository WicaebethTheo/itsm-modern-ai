"""Paramètres de connexion GLPI résolus (value object).

Bundle typé des réglages GLPI (`config/settings.py`) une fois les tokens déchiffrés.
Placé dans `config/` (couche la plus basse, ne dépend de rien) pour qu'adapters ET
services puissent l'importer sans dépendance croisée entre couches.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class GlpiCredentials:
    base_url: str
    user_token: str
    app_token: str
    verify_tls: bool
    timeout_seconds: float
    followup_legacy_9x: bool

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url and self.user_token)


@dataclass(frozen=True)
class GlpiV2Credentials:
    """Connexion à l'API haut-niveau GLPI 11 (« V2 », OAuth2) — Beta.

    `base_url` pointe sur la racine versionnée (ex. `…/api.php/v2.3`). L'auth se fait par
    grant OAuth2 **password** (client OAuth GLPI + compte technique).
    """

    base_url: str
    client_id: str
    client_secret: str
    username: str
    password: str
    verify_tls: bool
    timeout_seconds: float
    scope: str = "api user"  # scopes OAuth demandés (espace) ; `api`+`user` pour tout couvrir

    @property
    def is_configured(self) -> bool:
        return bool(
            self.base_url
            and self.client_id
            and self.client_secret
            and self.username
            and self.password
        )
