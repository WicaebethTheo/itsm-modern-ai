# ── Étape 1 : build de l'UI (SPA React/Vite) ─────────────────────────────────
FROM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Étape 2 : moteur Python + UI statique ─────────────────────────────────────
FROM python:3.13-slim

# uv pour la gestion des deps (cohérent avec le dev).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# hatchling (editable) a besoin du package et du README dès l'install.
COPY pyproject.toml uv.lock* README.md ./
COPY src ./src
RUN uv venv && uv pip install -e .

# Migrations + entrypoint.
COPY migrations ./migrations
COPY alembic.ini ./
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

# UI buildée (servie en statique par FastAPI à /).
COPY --from=ui /ui/dist ./frontend/dist

EXPOSE 8000
ENTRYPOINT ["./docker/entrypoint.sh"]
