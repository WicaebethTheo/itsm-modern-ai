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
