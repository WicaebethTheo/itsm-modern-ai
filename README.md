# ITSM Modern AI — moteur de triage GLPI à garde-fous

Assistant IA de triage de tickets pour **GLPI** : application autonome **on-premise** qui
classe, priorise, route et propose une réponse pour les tickets que les règles GLPI ne
savent pas traiter (la « Queue longue »), **toujours derrière un garde-fou déterministe**.
Open-core, souverain (Mistral EU par défaut), français.

> **Invariant produit :** le LLM **propose**, le code **valide et décide** (whitelist
> déterministe). Mode suggestion uniquement (jamais de modification d'un champ GLPI),
> masquage PII avant tout appel LLM, fallback unique « à trier ».

## État du projet — pilote V1 complet (Epics 1→4)

Séquençage : `Epic 1 (spike) → [GO humain] → Epic 2 → Epic 3 → Epic 4`.

- ✅ **Epic 1 — Spike de validation** (`scripts/spike_routing.py`) : mesure routage prose + précision LLM. Voir [`docs/spike.md`](docs/spike.md).
- ✅ **Epic 2 — Fondations & connexion GLPI** : daemon FastAPI headless, connecteur GLPI legacy (`apirest.php`), lecture des Tickets « New », référentiels/Whitelist, écriture de Suivi interne privé (mode suggestion), polling idempotent (APScheduler), healthcheck.
- ✅ **Epic 3 — Moteur à garde-fous** : pipeline à ordre immuable (étage 1 règles GLPI → cost cap → masquage → LLM JSON mode + retry → Pydantic → whitelist → seuil → Suivi / « à trier »). Mode suggestion, veto implicite. Endpoint `/api/sandbox` (triage à blanc).
- ✅ **Epic 4 — Audit, conformité & packaging** : log exhaustif des appels LLM (masqué), journal de décision annotable, export CSV DPO, auth locale (Argon2 + session), secrets chiffrés (Fernet), healthcheck GLPI **et** LLM + compteurs, Docker + docs (install, DPO, SECURITY).
- ✅ **Phase 2 — UI web (SPA React) & connecteur Anthropic** : interface **React 19 + Vite + Tailwind v4** (façon shadcn/ui) servie en statique par le moteur à la racine **`/`** : login, dashboard, statut, journal annotable, sandbox, et **toute la configuration dans l'UI** — connexion GLPI, fournisseur IA (Mistral EU **ou Anthropic/Claude**, FR-12), seuils, et **fiches techniciens CRUD** (stockées en base, plus de YAML). Clé LLM et tokens GLPI saisis dans l'interface (jamais `.env`), chiffrés au repos.

UI : **`/`** (SPA). API : `/health` · `/api/status` · `/api/metrics` · `/api/auth/*` · `/api/config` · `/api/sandbox` · `/api/decisions` (+ `PATCH .../annotation`) · `/api/tech-profiles` (CRUD) · `/api/export/{decisions,llm-calls}.csv`. OpenAPI sur `/docs`.

> **Souveraineté** : le défaut reste Mistral EU. Anthropic (Claude) est hors UE — son activation est un choix explicite de l'opérateur, à valider avec la DPO (cf. `docs/dpo.md`).

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
make install          # venv (uv) + deps Python
make lint             # ruff
make test             # pytest (87 tests : masquage, whitelist, GLPI mocké, idempotence, API…)
make migrate          # alembic upgrade head
make ui               # build de la SPA (npm install + build -> frontend/dist) — requiert Node 22
make run              # uvicorn + scheduler ; UI sur http://localhost:8000

# Dev UI (hot reload, proxy /api -> :8000) :
make ui-dev           # http://localhost:5173

# Déploiement on-prem (build UI inclus dans l'image multi-stage) :
cp .env.example .env  # renseigner MASTER_KEY + ADMIN_PASSWORD
docker compose up --build

# Spike Epic 1 (homelab) :
make spike-mock       # offline ; make spike → vraie mesure (LLM_API_KEY pour le CLI)
```

Tout se configure ensuite **dans l'interface** (`/`) : connexion GLPI, fournisseur IA
(clé Mistral/Anthropic), seuils, fiches techniciens. Rien dans `.env` côté secrets.

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
├── persistence/   # SQLModel/SQLite, idempotence, journal/audit, tables
└── api/           # FastAPI : app+lifespan, routes REST, spa.py (sert la SPA)
frontend/          # SPA React 19 + Vite + Tailwind v4 (buildée -> frontend/dist)
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

- [`docs/install.md`](docs/install.md) — installation on-prem (½ page). [`docs/dpo.md`](docs/dpo.md) — fiche DPO. [`SECURITY.md`](SECURITY.md).
- [`docs/spike.md`](docs/spike.md) — spike Epic 1. [`docs/handoff.md`](docs/handoff.md) — passation.
- [`planning/`](planning/) — PRD, architecture, epics, addendum. [`project-context.md`](project-context.md) — règles & invariants.

## Licence

MIT (cf. `LICENSE`).
