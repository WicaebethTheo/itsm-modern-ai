# ── Étape 1 : build de l'UI (SPA React/Vite) ─────────────────────────────────
FROM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Étape 2 : moteur Python + UI statique ─────────────────────────────────────
FROM python:3.13-slim

# uv pour la gestion des deps (cohérent avec le dev). Version PINNÉE (repro : le tag
# `latest` contredisait le « build reproductible » plus bas).
COPY --from=ghcr.io/astral-sh/uv:0.11.25 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    ITSM_RUNTIME=docker \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# Utilisateur non-root créé TÔT (durcissement prod) : les COPY suivants portent
# `--chown=app:app`, ce qui évite le `chown -R app:app /app` final — ce dernier
# re-copiait tout le venv dans une couche dédiée (poids et pull inutiles). Le venv
# installé par les RUN ci-dessous reste possédé par root : voulu (lecture seule
# pour `app` au runtime, seul ./data doit lui appartenir). `gosu` permet à
# l'entrypoint, démarré en root, de fixer l'ownership du volume ./data (root au
# départ) puis de redescendre en `app` pour exécuter le moteur. gosu n'est
# volontairement PAS épinglé côté apt (`gosu=x.y-z` n'est pas portable) : sa
# version est déjà figée par le snapshot Debian du tag de l'image de base, et un
# pin apt casserait le build à chaque bump de la distro sans rien reproduire de plus.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app --gid=10001 \
    && useradd -r -g app --uid=10001 --home-dir=/app --shell=/usr/sbin/nologin app \
    && mkdir -p /app/data \
    && chown app:app /app /app/data

# Build REPRODUCTIBLE : on installe depuis uv.lock (versions épinglées + hashes),
# pas une résolution libre. `uv sync --frozen` échoue si le lock est incohérent
# avec pyproject (garde-fou CI). `--no-dev` exclut les deps de dev (pytest, ruff…).
# `--extra postgres` embarque le driver psycopg : l'image supporte ainsi SQLite (défaut)
# ET PostgreSQL (profile compose `postgres`) sans rebuild dédié.
# Les deps SEULES d'abord (`--no-install-project` ne lit pas src/) : la couche la
# plus lourde n'est invalidée que par un changement de lock, pas à chaque commit de
# code. Le cache uv est un cache mount : il accélère les rebuilds sans jamais être
# stocké dans les couches de l'image. hatchling a besoin du README dès l'install.
COPY --chown=app:app pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --extra postgres

# Image UNIQUE : tout `src/` est embarqué, y compris les features Supporter
# (`itsm_modern_ai/features/`). Elles restent verrouillées tant qu'aucune licence
# valide n'est fournie (déverrouillage en place, pas de swap d'image).
COPY --chown=app:app src ./src
# Le projet lui-même, installé APRÈS les deps (editable : hatchling lit src/ + README).
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --no-deps -e .

# Migrations + entrypoint.
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app alembic.ini ./
COPY --chown=app:app docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

# UI buildée (servie en statique par FastAPI à /).
COPY --from=ui --chown=app:app /ui/dist ./frontend/dist

EXPOSE 8000

# Healthcheck intégré : la voie `docker run` nue n'a aucun compose pour en fournir
# un (les composes gardent le leur, qui override celui-ci). /health SANS ?probe=true :
# la sonde profonde (DB, GLPI…) serait trop coûteuse répétée toutes les 30 s.
# urllib plutôt que curl : déjà dans l'image, zéro dépendance apt en plus.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"

ENTRYPOINT ["./docker/entrypoint.sh"]
