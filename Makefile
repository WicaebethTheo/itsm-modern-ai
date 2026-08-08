.PHONY: install update backup lint test fmt run migrate set-admin-password ui ui-dev ui-lint ui-test ui-e2e spike spike-mock glpi-diagnose

install:
	uv venv --python 3.14
	uv pip install -e ".[dev]"

# Déploiement on-prem (Docker) : mise à jour avec sauvegarde préalable (via l'installeur unique).
update:
	./install.sh --update

# ── Sauvegarde SQLite COHÉRENTE, à chaud ─────────────────────────────────────
# Pourquoi pas un `cp data/itsm.db` : le moteur tourne en `journal_mode=WAL`
# (persistence/db.py). Tant que le WAL n'est pas checkpointé, les écritures récentes
# vivent dans `itsm.db-wal` (5 à 16 Mo en régime, soit des SEMAINES de journal) et
# le fichier principal peut être quasi VIDE. Une copie du seul `itsm.db` est donc
# une sauvegarde muette et inutilisable ("no such table: …" à la restauration).
#
# On utilise `VACUUM INTO` (repli : l'API `.backup` de SQLite pour les SQLite < 3.27) :
# un SEUL fichier, cohérent, WAL inclus, sans arrêter le service. La copie est ensuite
# vérifiée par `PRAGMA integrity_check` ET par un comptage réel des tables/lignes.
# Tout échec est BRUYANT (exit != 0, dossier de sauvegarde incomplet supprimé).
define BACKUP_PY
import sqlite3, sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
con = sqlite3.connect(str(src), timeout=30)
try:
    con.execute("PRAGMA busy_timeout=30000")
    try:
        # Snapshot cohérent (lecture seule côté source) : WAL non checkpointé inclus.
        con.execute("VACUUM INTO ?", (str(dst),))
    except sqlite3.OperationalError as exc:
        if "syntax error" not in str(exc).lower() and "near" not in str(exc).lower():
            raise
        # SQLite < 3.27 : pas de VACUUM INTO -> API .backup (pages=0 = copie en une passe).
        out = sqlite3.connect(str(dst))
        try:
            con.backup(out, pages=0)
        finally:
            out.close()
finally:
    con.close()

chk = sqlite3.connect("file:" + str(dst) + "?mode=ro", uri=True)
try:
    verdict = chk.execute("PRAGMA integrity_check").fetchone()[0]
    tables = [r[0] for r in chk.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )]
    rows = sum(chk.execute("SELECT count(*) FROM \"" + t + "\"").fetchone()[0] for t in tables)
finally:
    chk.close()

if verdict != "ok":
    sys.exit("integrity_check a REFUSE la copie : " + str(verdict))
if not tables:
    sys.exit("copie VIDE (aucune table) - sauvegarde refusee")
size = dst.stat().st_size
print("%s  (%.2f Mio, %d tables, %d lignes, integrity_check: ok)" % (dst, size / 1048576.0, len(tables), rows))
endef
export BACKUP_PY

# Sauvegarde horodatée de ./data : base SQLite (copie cohérente) + master.key.
# ⚠️ master.key est INDISPENSABLE : sans elle, la base restaurée est illisible
# (mot de passe admin, tokens GLPI, clé LLM sont chiffrés avec).
# Restauration : voir la procédure imprimée en fin de commande, ou `./install.sh --rollback <ts>`.
backup:
	@set -e; \
	if grep -qiE '^[[:space:]]*ITSM_DATABASE_URL=.*postgres' .env 2>/dev/null; then \
	  printf '\033[1;31m✗ Instance PostgreSQL détectée (ITSM_DATABASE_URL) : `make backup` ne sauvegarde que SQLite.\033[0m\n' >&2; \
	  echo "  Utilisez : docker compose exec -T postgres pg_dump -U itsm itsm > dump.sql" >&2; \
	  exit 1; \
	fi; \
	src=data/itsm.db; \
	[ -f "$$src" ] || { printf '\033[1;31m✗ Base introuvable : %s — rien à sauvegarder.\033[0m\n' "$$src" >&2; exit 1; }; \
	PY=""; for c in .venv/bin/python python3 python; do command -v "$$c" >/dev/null 2>&1 && { PY="$$c"; break; }; done; \
	[ -n "$$PY" ] || { printf '\033[1;31m✗ Aucun interpréteur Python trouvé — sauvegarde impossible.\033[0m\n' >&2; exit 1; }; \
	ts=$$(date +%Y%m%d-%H%M%S); bk="backups/$$ts"; mkdir -p "$$bk"; \
	if ! "$$PY" -c "$$BACKUP_PY" "$$src" "$$bk/itsm.db"; then \
	  rm -rf "$$bk"; \
	  printf '\033[1;31m✗ SAUVEGARDE ÉCHOUÉE — aucune sauvegarde exploitable produite (voir ci-dessus).\033[0m\n' >&2; \
	  exit 1; \
	fi; \
	if [ -f data/master.key ]; then cp -a data/master.key "$$bk/" && chmod 600 "$$bk/master.key"; \
	else printf '\033[1;33m! data/master.key absente : MASTER_KEY doit venir de .env — sauvegardez-le AUSSI.\033[0m\n'; fi; \
	printf '\033[1;32m✓ Sauvegarde → %s\033[0m\n' "$$bk"; \
	echo "  Restauration : docker compose stop"; \
	echo "                 cp -a $$bk/itsm.db data/itsm.db && rm -f data/itsm.db-wal data/itsm.db-shm"; \
	echo "                 cp -a $$bk/master.key data/master.key   # si présente"; \
	echo "                 docker compose up -d"; \
	echo "  Ou, en une commande (base + code + image) : ./install.sh --rollback $$ts"

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
