"""Point d'entrée : `uvicorn itsm_modern_ai.main:app`."""

from __future__ import annotations

from .api.app import app

__all__ = ["app"]
