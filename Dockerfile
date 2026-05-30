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

# Build REPRODUCTIBLE : on installe depuis uv.lock (versions épinglées + hashes),
# pas une résolution libre. `uv sync --frozen` échoue si le lock est incohérent
# avec pyproject (garde-fou CI). `--no-dev` exclut les deps de dev (pytest, ruff…).
# `--extra postgres` embarque le driver psycopg : l'image supporte ainsi SQLite (défaut)
# ET PostgreSQL (profile compose `postgres`) sans rebuild dédié.
# hatchling (editable) a besoin du package et du README dès l'install.
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --frozen --no-dev --no-install-project --extra postgres \
    && uv pip install --no-deps -e .

# Migrations + entrypoint.
COPY migrations ./migrations
COPY alembic.ini ./
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

# UI buildée (servie en statique par FastAPI à /).
COPY --from=ui /ui/dist ./frontend/dist

# Utilisateur non-root (durcissement prod). `gosu` permet à l'entrypoint, démarré
# en root, de fixer l'ownership du volume ./data (root au départ) puis de redescendre
# en `app` pour exécuter le moteur. Tout /app est donné à `app` (venv inclus).
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app --gid=10001 \
    && useradd -r -g app --uid=10001 --home-dir=/app --shell=/usr/sbin/nologin app \
    && mkdir -p /app/data \
    && chown -R app:app /app

EXPOSE 8000
ENTRYPOINT ["./docker/entrypoint.sh"]
