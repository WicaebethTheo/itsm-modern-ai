.PHONY: install update backup lint test fmt run migrate set-admin-password ui ui-dev ui-lint ui-test ui-e2e spike spike-mock glpi-diagnose

install:
	uv venv --python 3.13
	uv pip install -e ".[dev]"

# Déploiement on-prem (Docker) : mise à jour avec sauvegarde préalable (via l'installeur unique).
update:
	./install.sh --update

# Sauvegarde horodatée du volume ./data (base SQLite + master.key).
backup:
	@ts=$$(date +%Y%m%d-%H%M%S); mkdir -p backups/$$ts; \
	cp -a data/itsm.db data/master.key backups/$$ts/ 2>/dev/null || true; \
	echo "Sauvegarde → backups/$$ts"

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

# Définit / change le mot de passe admin (hash Argon2 chiffré ; jamais en clair).
# `make migrate` au préalable si la base n'existe pas encore.
set-admin-password:
	uv run python -m itsm_modern_ai.admin_setup --force

# UI (SPA React) : build de production -> frontend/dist (servi par le moteur)
ui:
	cd frontend && npm install && npm run build

# UI en dev (hot reload, proxy /api vers :8000)
ui-dev:
	cd frontend && npm run dev

# UI : lint (Biome) + typecheck
ui-lint:
	cd frontend && npm run lint && npm run typecheck

# UI : tests unitaires/composants (Vitest + Testing Library)
ui-test:
	cd frontend && npm test

# UI : E2E (Playwright, API mockée) — 1ère fois : npx playwright install --with-deps chromium
ui-e2e:
	cd frontend && npm run test:e2e

# Spike Epic 1 — vrai LLM (nécessite LLM_API_KEY, défaut Mistral EU)
spike:
	uv run python scripts/spike_routing.py --real

# Spike Epic 1 — mock offline (plomberie seulement, NON représentatif)
spike-mock:
	uv run python scripts/spike_routing.py --mock

# Diagnostic de connexion GLPI (identifiants via l'environnement, jamais en dur)
glpi-diagnose:
	uv run python scripts/glpi_diagnose.py
