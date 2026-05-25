# ITSM Modern AI — moteur de triage GLPI à garde-fous

Assistant IA de triage de tickets pour **GLPI** : application autonome **on-premise** qui
classe, priorise, route et propose une réponse pour les tickets que les règles GLPI ne
savent pas traiter (la « Queue longue »), **toujours derrière un garde-fou déterministe**.
Open-core, souverain (Mistral EU par défaut), français.

> **Invariant produit :** le LLM **propose**, le code **valide et décide** (whitelist
> déterministe). Mode suggestion uniquement (jamais de modification d'un champ GLPI),
> masquage PII avant tout appel LLM, fallback unique « à trier ».

## État du projet

Séquençage : `Epic 1 (spike) → [GO humain] → Epic 2 → Epic 3 → Epic 4`.

- ✅ **Epic 1 — Spike de validation** (`scripts/spike_routing.py`) : mesure routage prose + précision LLM. Voir [`docs/spike.md`](docs/spike.md).
- ✅ **Epic 2 — Fondations & connexion GLPI** : daemon FastAPI headless, connecteur GLPI legacy (`apirest.php`), lecture des Tickets « New », référentiels/Whitelist, écriture de Suivi interne privé (mode suggestion), polling idempotent (APScheduler), healthcheck. Config & secrets poussés au runtime via l'API (pas `.env`).
- ⏳ **Epic 3 — Moteur à garde-fous** (masquage→LLM→whitelist→seuil→Suivi) : le seam `ticket_handler` du poller est prêt à le recevoir.
- ⏳ **Epic 4 — Audit, auth, packaging** (journal, export CSV, auth locale, HTTPS).

## Configuration : secrets poussés via l'API/UI (jamais `.env`)

La **clé API LLM** et les **tokens GLPI** ne se mettent **pas** dans `.env` : ils sont
poussés au runtime via `POST /api/config` (que l'UI Phase 2 consommera) et stockés
**chiffrés au repos** (Fernet, FR-25). Le `GET /api/config` ne renvoie jamais la valeur
d'un secret, seulement un booléen `*_set`. `.env` ne porte que les réglages non-secrets,
la `MASTER_KEY` de chiffrement et l'URL de base de données.

```bash
# Pousser la clé LLM + la connexion GLPI (équivalent de ce que fera l'UI) :
curl -X POST http://localhost:8000/api/config -H 'Content-Type: application/json' -d '{
  "glpi_base_url": "https://glpi.exemple.local/apirest.php",
  "glpi_user_token": "xxxxx",
  "llm_api_key": "yyyyy"
}'
```

## Démarrage rapide

```bash
make install          # venv (uv) + deps
make lint             # ruff
make test             # pytest (53 tests : masquage, whitelist, GLPI mocké, idempotence, API…)
make migrate          # alembic upgrade head
make run              # uvicorn + scheduler de polling (http://localhost:8000)

# Déploiement on-prem :
cp .env.example .env  # renseigner MASTER_KEY (sinon auto-générée dans data/)
docker compose up --build

# Spike Epic 1 (homelab) :
make spike-mock       # offline ; make spike → vraie mesure (LLM_API_KEY pour le CLI)
```

API headless : `/health` (FR-27), `/api/status`, `/api/config`. OpenAPI sur `/docs`.

## Structure (hexagonale)

```
src/itsm_modern_ai/
├── domain/        # cœur : models, engine (whitelist+seuil), masking, prompting — AUCUN adaptateur
├── ports/         # interfaces (Protocol) : ItsmPort, LlmPort, SecretsPort
├── adapters/
│   ├── itsm/glpi/ # client apirest.php, mapper (ITILFollowup), connector (ItsmPort)
│   ├── llm/       # OpenAI-compatible (défaut Mistral) + mock offline
│   └── secrets/   # chiffrement Fernet (FR-25)
├── services/      # tech_profiles, runtime_config (secrets/config), whitelist_cache
├── scheduler/     # poller APScheduler (idempotent, FR-2)
├── persistence/   # SQLModel/SQLite, idempotence, tables
└── api/           # FastAPI : app+lifespan, routes health/status/config
migrations/        # Alembic
scripts/spike_routing.py        # Spike Epic 1
tests/             # unit + integration (respx) ; fixtures/tickets_fr.json
planning/          # PRD, architecture, epics, addendum (specs)
```

## Stack

Python 3.12+, FastAPI/uvicorn, SQLModel (SQLite, Postgres-ready) + Alembic, Pydantic v2 +
pydantic-settings, APScheduler, cryptography, httpx. Tests : pytest + respx. Lint : ruff.
Deps : uv. Docker + docker-compose (on-prem).

## Documentation

- [`planning/`](planning/) — PRD, architecture, epics, addendum.
- [`project-context.md`](project-context.md) — règles & invariants pour tout agent.
- [`docs/spike.md`](docs/spike.md) — spike Epic 1. [`docs/handoff.md`](docs/handoff.md) — passation.

## Licence

MIT (cf. `LICENSE`).
