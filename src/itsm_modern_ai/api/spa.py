"""Sert la SPA React buildée (frontend/dist) — Phase 2.

L'UI est une application React/Vite compilée en fichiers statiques (aucun serveur
Node au runtime). FastAPI sert les assets et renvoie index.html pour les routes
clientes (react-router), tout en laissant /api et /health au backend.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger("itsm.spa")


def mount_spa(app: FastAPI, dist_dir: Path) -> None:
    if not dist_dir.exists() or not (dist_dir / "index.html").exists():
        logger.warning("UI non buildée (%s introuvable) — exécuter `npm run build`", dist_dir)

        @app.get("/", include_in_schema=False)
        def _no_ui() -> JSONResponse:
            return JSONResponse(
                {"code": "ui_not_built", "message": "UI non compilée. Lancer `make ui` / `npm run build`."}
            )

        return

    assets = dist_dir / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    index_html = (dist_dir / "index.html").read_text(encoding="utf-8")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str, request: Request):
        # Les chemins API/health ont leurs routes ; un /api/* inconnu doit 404 en JSON.
        if full_path.startswith(("api/", "health", "docs", "openapi.json", "redoc")):
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": full_path})
        # Fichier statique existant à la racine du build (favicon, etc.).
        candidate = dist_dir / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        # Sinon : route cliente → index.html (SPA fallback).
        return HTMLResponse(index_html)
