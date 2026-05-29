<div align="center">

<img src="frontend/public/favicon.svg" width="80" alt="ITSM Modern AI" />

# ITSM Modern AI

**Moteur de triage IA des tickets GLPI — souverain, à garde-fous, on-premise.**

*The LLM proposes, the code decides — GLPI ticket triage with deterministic guardrails.*

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.7.0-blueviolet)](pyproject.toml)
[![Python 3.12+](https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Tests](https://img.shields.io/badge/tests-180_pytest_%C2%B7_58_vitest_%C2%B7_3_e2e-success)](#tests--qualité)
[![Sovereign](https://img.shields.io/badge/sovereign-Mistral_EU_default-6B46C1)](docs/dpo.md)

[Pourquoi ?](#pourquoi-) · [Démarrage rapide](#démarrage-rapide) · [Modes](#modes-dexécution) · [Architecture](#architecture) · [Documentation](#documentation)

</div>

---

## Pourquoi ?

GLPI gère bien les tickets **structurés** (catégorie cochée, urgence renseignée, demandeur connu). Mais sa file accumule aussi tout le reste — la **« Queue longue »** : « ça marche plus », « le truc bleu », messages en argot, sans champ posé, sans pièce jointe. Ces tickets bloquent la qualité de service plancher : ils restent en attente, sont mal routés, ou répondus en retard.

**ITSM Modern AI** lit les tickets neufs, masque les données sensibles, propose une décision (catégorie, priorité, technicien/groupe, brouillon de réponse) — puis le **code** valide cette proposition contre une **whitelist déterministe** curée par l'admin avant toute action. Le LLM n'a pas la main : il propose, le code décide.

Le produit est conçu pour :

- **DSI françaises de PME** : déploiement on-premise, défaut souverain (Mistral EU), interface FR/EN, validation DPO facile.
- **Migration douce** : commence en mode `suggestion` (Suivi privé, aucune mutation GLPI) → bascule en `semi_auto`/`full_auto` quand la confiance est calibrée.
- **Open-core** : code MIT, monétisation par le service (support SLA, install/config, modules Enterprise hors-cible PME).

---

## Comment ça marche

Pipeline à **ordre immuable** — c'est l'ADN du produit, jamais réordonné :

```
GLPI poll  →  règles déterministes  →  cost cap  →  masquage PII
       (étage 1 — pas d'appel LLM si une règle traite déjà le Ticket)

      LLM (JSON mode, retry)  →  validation Pydantic  →  whitelist  →  seuil de confiance

                              ┌─── Décision valide ──→  Suivi GLPI (mode du périmètre)
                              │
                              └─── tout échec ─────→  « à trier » (fallback unique)
```

**Garanties absolues, tous modes confondus :**
- Aucune écriture GLPI sans validation whitelist + seuil.
- Aucune PII non masquée n'atteint le LLM (email, téléphone, IBAN, mot de passe/token).
- Aucune métrique par technicien (anti-mouchard, RGPD).
- Aucun phone-home (souveraineté).
- Une seule échappatoire : « à trier » — jamais de crash bloquant la file.

---

## Highlights

| | |
|---|---|
| **Whitelist curée depuis GLPI** | Scan GLPI (`POST /api/glpi/sync`) → l'admin sélectionne dans la console les catégories autorisées, les entités du périmètre, et les techniciens/groupes éligibles. Le moteur n'agit que dans ce **périmètre effectif** = GLPI ∩ sélections admin. |
| **Fiches techniciens en prose, en base** | Plus de YAML — chaque technicien et chaque groupe a une fiche libre éditable depuis l'UI. Le LLM s'en sert pour router ; le code rejette toute proposition hors périmètre. |
| **Routage technicien (préféré) ou groupe (fallback)** | Préférence pour un technicien nommé ; bascule sur un groupe éligible si aucun technicien ne convient. |
| **3 modes d'exécution par entité** | `suggestion` (Suivi privé, aucune mutation) · `semi_auto` (applique si confiance ≥ 2ᵉ seuil) · `full_auto` (applique + répond au demandeur en Suivi public). Réglés indépendamment par entité GLPI. |
| **4 fournisseurs LLM interchangeables** | **Mistral EU** (défaut souverain) · **OpenAI** · **Ollama** (local, sans clé) · **Anthropic / Claude**. Changement de fournisseur sans changement de code. |
| **Masquage PII configurable** | Email / téléphone / IBAN / mot de passe activables motif par motif (tous ON par défaut), avec avertissement DPO si on en désactive un. |
| **Cost cap glissant** | Plafond € / jour configurable (défaut 5 €) — au-delà, les Tickets restent « à trier » sans appel facturant. |
| **Sandbox** | `POST /api/sandbox` permet de tester un texte de ticket sans toucher GLPI. UI dédiée affiche la décision simulée + résolution des noms. |
| **Journal annotable + export CSV DPO** | Chaque décision est tracée (sans PII), annotable a posteriori. Export RGPD à la demande. |
| **Durcissement production** | Conteneur non-root (`gosu` + UID 10001), rate-limiting login (avec support `X-Forwarded-For` derrière proxy), scan de dépendances en CI (`pip-audit` + `npm audit`). |

---

## Démarrage rapide

### Avec Docker (recommandé, on-prem)

```bash
cp .env.example .env             # renseigner MASTER_KEY + ADMIN_PASSWORD
docker compose up -d --build     # build image multi-stage + démarre le service
open http://localhost:8000       # console web (SPA React)
```

> ⚠️ **Ne JAMAIS faire `docker compose down -v`** : `-v` supprime le volume `./data`
> qui contient la base SQLite + la `master.key` Fernet. La configuration repart à zéro.

Tout se configure ensuite **dans l'interface** : connexion GLPI, choix du fournisseur LLM, scan GLPI, sélection des catégories/entités/techniciens/groupes du périmètre, fiches en prose, modes par entité. **Aucun secret dans `.env`** — les tokens GLPI et clés LLM sont poussés via l'UI et chiffrés Fernet au repos.

### Développement local

```bash
make install     # venv (uv) + deps Python
make migrate     # alembic upgrade head
make ui          # build SPA (requiert Node 22)
make run         # uvicorn + scheduler → http://localhost:8000

# Frontend hot-reload (proxy /api → :8000) :
make ui-dev      # http://localhost:5173
```

### Test du spike (Epic 1, homelab)

```bash
make spike-mock  # offline, modèle déterministe
make spike       # avec un vrai LLM (LLM_API_KEY pour le CLI uniquement)
```

---

## Modes d'exécution

Réglables **par entité GLPI** dans la console (page Périmètre → `PUT /api/modes`). Défaut global sûr : `suggestion`.

| Mode | Mutation GLPI | Suivi | Réponse au demandeur | Quand l'utiliser |
|---|:---:|:---:|:---:|---|
| **`suggestion`** | aucune | **privé** (technicien seulement) | jamais | Démarrage, calibration, périmètres sensibles. |
| **`semi_auto`** | si confiance ≥ 2ᵉ seuil strict (défaut 0,9) | **public** si appliqué, privé sinon | si appliqué | Périmètres rodés, montée en confiance progressive. |
| **`full_auto`** | toujours (catégorie, urgence + priorité, assignation) | **public** | toujours | Catégories simples et bien outillées (mots de passe oubliés, etc.). |

Tous les modes appliquent **le même garde-fou** en amont (masquage, whitelist, seuil, fallback « à trier »). Les seuls effets variables sont la mutation et la visibilité du Suivi.

---

## Fournisseurs LLM

| Fournisseur | Souveraineté | Clé requise | Notes |
|---|---|:---:|---|
| **Mistral EU** | Souverain UE — **défaut** | oui | DPA signé, pas de Cloud Act. |
| **Ollama** | 100 % **local** | non | Exécution sur l'infra du client, aucune donnée ne sort. |
| **OpenAI** | Hors UE | oui | Activation = choix explicite de l'opérateur, validation DPO. |
| **Anthropic / Claude** | Hors UE | oui | Idem OpenAI ; supporte Sonnet 4.6+. |

Sélection sans code (UI → page IA). Les clés sont **chiffrées Fernet au repos**.

---

## Architecture

Hexagonale stricte (Domain ↔ Ports ↔ Adapters) — le domaine n'importe aucun adaptateur, les invariants tiennent à la frontière.

```
src/itsm_modern_ai/
├── domain/        cœur : models, engine (whitelist + seuil), masking, prompting
├── ports/         interfaces (Protocol) : ItsmPort, LlmPort, SecretsPort
├── adapters/
│   ├── itsm/glpi/   client apirest.php + mapper (ITILFollowup 9.x/10.x)
│   ├── llm/         Mistral EU · OpenAI · Ollama · Anthropic + mock offline
│   └── secrets/     chiffrement Fernet
├── services/      référentiels (scan + périmètre), runtime_config, triage
├── scheduler/     poller APScheduler (idempotent)
├── persistence/   SQLModel/SQLite, journal, idempotence, UtcDateTime
├── config/        Settings (pydantic-settings) + credentials GLPI
└── api/           FastAPI : routes REST, auth (Argon2), rate-limit, SPA static
frontend/          SPA React 19 + Vite 6 + Tailwind v4 (i18n FR/EN, Biome)
migrations/        Alembic
scripts/           spike_routing.py (Epic 1), diagnostics GLPI
tests/             pytest + respx (unit + integration)
docs/              project-context, install, dpo, spike, design/
```

Le moteur reste **headless** : la SPA React est servie en statique par le moteur (image Docker multi-stage `node:22 → python:3.13`), aucun serveur Node au runtime. Le contrat REST est l'API publique du moteur — CLI/Slack/batch peuvent s'y brancher demain.

---

## Stack technique

| Couche | Technologies |
|---|---|
| **Backend** | Python 3.12+, FastAPI, uvicorn, SQLModel (SQLite → Postgres-ready), Alembic, Pydantic v2, pydantic-settings, APScheduler, cryptography (Fernet), pwdlib/Argon2, httpx |
| **Frontend** | React 19, Vite 6, Tailwind v4 (façon shadcn/ui), React Router 7, Lucide icons, i18n FR/EN |
| **Qualité** | ruff (Python), Biome (TS/CSS), pytest + respx, Vitest + Testing Library, Playwright (E2E) |
| **Infra** | Docker multi-stage, docker-compose, conteneur non-root (`gosu` + UID 10001), volume `./data` (SQLite + master.key), healthcheck HTTP, reverse proxy HTTPS |
| **CI (GitLab)** | `ruff` · `pytest` · `biome` · `tsc` · `vitest` · `playwright` · `pip-audit` · `npm audit` |

---

## API

Endpoints publics : `GET /health` (avec version GLPI) · `GET /api/status` · `GET /api/metrics` · `GET /api/operational-metrics` (dashboard inversé).

Authentification (Argon2 + session signée) : `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/status`.

Configuration : `GET/POST /api/config` (secrets via UI, `*_set` booléens en GET) · `POST /api/glpi/sync` (scan référentiels).

Périmètre : `GET /api/discovery/{category|entity|technician|group}` · `GET/PUT /api/scope` · `PUT /api/modes` · `PUT /api/technicians` · `PUT /api/groups`.

Triage : `POST /api/sandbox` (test à blanc) · `GET /api/decisions` · `PATCH /api/decisions/{id}/annotation` · `GET /api/export/{decisions,llm-calls}.csv`.

Automations RGPD : `GET/PATCH /api/automations/retention` · `POST /api/automations/retention/run`.

Debug (gatés par `DEBUG_TOOLS_ENABLED`) : `/api/debug/{status,info,diagnostics,seed,purge-users}`.

Spec OpenAPI complète sur `/docs`.

---

## Tests & qualité

| Suite | Compte | Commande |
|---|---:|---|
| **pytest** (unit + integration via `respx`) | **180** | `make test` |
| **Vitest + Testing Library** (composants + pages) | **58** | `make ui-test` |
| **Playwright** (E2E, API mockée) | **3 parcours** | `make ui-e2e` |
| **ruff** (Python) | 0 violation | `make lint` |
| **Biome + tsc** (TS/JSX) | 0 violation | `make ui-lint` |

Chemins critiques couverts : pipeline immuable, masquage PII, whitelist (catégorie/priorité/technicien/groupe), seuil de confiance, cost cap glissant, 3 modes d'exécution, mode par entité, idempotence du polling, secrets Fernet, rate-limit login, retentions RGPD.

---

## Sécurité & RGPD

- **On-premise**, aucun phone-home, aucun appel sortant hors fournisseur LLM configuré.
- **Secrets chiffrés Fernet** au repos ; `master.key` montée comme volume Docker, mode `0600`.
- **Pas de PII en clair** envoyée au LLM (masquage avant l'appel ; logs reflètent le masquage).
- **Pas de métrique nominative** par technicien (anti-mouchard).
- **Conteneur non-root**, rate-limit login en mémoire (`429 + Retry-After`), `X-Forwarded-For` honoré derrière reverse proxy si `TRUST_PROXY_HEADERS=true`.
- **Export CSV DPO** à la demande ; rétention RGPD automatisée (purge périodique du Journal et des appels LLM, fenêtres configurables).
- Voir [`SECURITY.md`](SECURITY.md) (politique de divulgation) et [`docs/dpo.md`](docs/dpo.md) (fiche DPO 1 page).

---

## Documentation

| | |
|---|---|
| [`docs/install.md`](docs/install.md) | Installation on-prem en ½ page |
| [`docs/dpo.md`](docs/dpo.md) | Fiche DPO 1 page (validation RGPD) |
| [`docs/spike.md`](docs/spike.md) | Spike Epic 1 — protocole et résultats |
| [`docs/project-context.md`](docs/project-context.md) | Invariants non-négociables (à lire avant de coder) |
| [`docs/design/`](docs/design/) | Specs design (palette de couleurs, cartes) |
| [`CHANGELOG.md`](CHANGELOG.md) | Historique des changements (keep-a-changelog) |
| [`SECURITY.md`](SECURITY.md) | Politique de sécurité et divulgation |

---

## Roadmap

**Pilote V1 livré** — Epics 1 → 4 + Phase 2 UI (cf. [`CHANGELOG.md`](CHANGELOG.md)).

**Pistes ouvertes** :

- Portage **PostgreSQL** (le code est déjà `Postgres-ready` ; toutes les colonnes `ts` sont timezone-aware via `UtcDateTime`).
- **Store / Automations marketplace** (placeholders UI ; backing en cours pour la rétention RGPD).
- **Modules Enterprise** (multi-tenant, SSO SAML, audit log signé) — open-core, hors cible PME.
- Couverture **E2E** étendue (Scope/Modes, EngineSettings, Technicians en parcours réel).
- Connecteur **GLPI API V2** (le seam est prêt, l'API legacy `apirest.php` reste la source de vérité).

---

## Licence

[MIT](LICENSE) — open-core, monétisation par le service (support SLA, install/config, prestations, modules Enterprise). 

---

<div align="center">

Conçu pour les DSI qui veulent **garder la main** : le LLM propose, le code décide.

</div>
