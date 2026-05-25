#!/usr/bin/env bash
# Applique les migrations (Alembic = source de vérité) puis démarre le moteur.
set -euo pipefail

echo "[entrypoint] alembic upgrade head"
alembic upgrade head

echo "[entrypoint] démarrage uvicorn"
exec uvicorn itsm_modern_ai.main:app --host 0.0.0.0 --port 8000
