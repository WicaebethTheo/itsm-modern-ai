.PHONY: install lint test spike spike-mock fmt

install:
	uv venv --python 3.13
	uv pip install -e ".[dev]"

lint:
	uv run ruff check .

fmt:
	uv run ruff check --fix .

test:
	uv run pytest -q

# Spike Epic 1 — vrai LLM (nécessite LLM_API_KEY, défaut Mistral EU)
spike:
	uv run python scripts/spike_routing.py --real

# Spike Epic 1 — mock offline (plomberie seulement, NON représentatif)
spike-mock:
	uv run python scripts/spike_routing.py --mock
