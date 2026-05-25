.PHONY: install lint test fmt run migrate spike spike-mock

install:
	uv venv --python 3.13
	uv pip install -e ".[dev]"

lint:
	uv run ruff check .

fmt:
	uv run ruff check --fix .

test:
	uv run pytest -q

# Lance le moteur headless en local (API + scheduler de polling)
run:
	uv run uvicorn itsm_modern_ai.main:app --reload --port 8000

# Applique les migrations Alembic
migrate:
	uv run alembic upgrade head

# UI (SPA React) : build de production -> frontend/dist (servi par le moteur)
ui:
	cd frontend && npm install && npm run build

# UI en dev (hot reload, proxy /api vers :8000)
ui-dev:
	cd frontend && npm run dev

# Spike Epic 1 — vrai LLM (nécessite LLM_API_KEY, défaut Mistral EU)
spike:
	uv run python scripts/spike_routing.py --real

# Spike Epic 1 — mock offline (plomberie seulement, NON représentatif)
spike-mock:
	uv run python scripts/spike_routing.py --mock
