# Image unique du moteur headless (on-prem, docker-compose).
FROM python:3.12-slim

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

EXPOSE 8000
ENTRYPOINT ["./docker/entrypoint.sh"]
