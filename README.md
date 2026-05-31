<div align="center">

<img src="frontend/public/favicon.svg" width="80" alt="ITSM Modern AI" />

# ITSM Modern AI

**Moteur de triage IA des tickets GLPI — souverain, à garde-fous, on-premise.**

*The LLM proposes, the code decides — GLPI ticket triage with deterministic guardrails.*

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.8.2-blueviolet)](pyproject.toml)
[![Python 3.13+](https://img.shields.io/badge/Python-3.13+-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Tests](https://img.shields.io/badge/tests-276_pytest_%C2%B7_63_vitest_%C2%B7_3_e2e-success)](docs/testing.md)
[![Sovereign](https://img.shields.io/badge/sovereign-Mistral_EU_default-6B46C1)](docs/llm-providers.md)

[Démarrage rapide](#démarrage-rapide) · [Fonctionnalités](docs/features.md) · [Architecture](docs/architecture.md) · [Documentation](#documentation)

</div>

---

## En une phrase

GLPI gère bien les tickets structurés. **ITSM Modern AI** prend en charge le reste — la « Queue longue » : tickets flous, mal formulés, sans champ posé. Le LLM propose, le **code valide et décide** (whitelist déterministe, masquage PII avant tout appel LLM, fallback unique « à trier »). On-premise, souverain (Mistral EU par défaut), open-core MIT.

➜ **[Pourquoi ce produit existe](docs/architecture.md#pourquoi-ce-produit-existe)** · **[Comment ça marche](docs/architecture.md#pipeline-immuable)**

---

## Démarrage rapide

### Avec Docker (recommandé, on-prem)

```bash
# En une ligne (clone + install) — nécessite que le dépôt soit accessible :
curl -fsSL https://itsm-modern-ai.com/install | sh

# Ou depuis le dépôt cloné :
./install.sh                     # vérifie les prérequis, démarre, demande un mot de passe admin
./install.sh --bundle itsm.tar.gz   # install hors-ligne depuis une image (air-gap)
open http://localhost:8000       # console web (SPA React)
```

`install.sh` **vérifie les prérequis** (Docker, plugin compose, disque, port) et **propose
de les installer** (installation de Docker via le script officiel, plugin compose via le
binaire officiel — toutes distros), applique les migrations, démarre le service et crée le
compte administrateur (mot de passe saisi à l'écran, stocké **uniquement en hash Argon2
chiffré**), puis affiche une **checklist** de l'état du système. Changer le mot de passe :
`./install.sh --reset-password`.

<details><summary>Install manuelle (équivalent)</summary>

```bash
cp .env.example .env                                    # MASTER_KEY auto-générée dans ./data
docker compose up -d --build                            # build + démarre (migrations incluses)
docker compose exec itsm python -m itsm_modern_ai.admin_setup   # mot de passe admin (masqué)
```
</details>

> ⚠️ **Ne JAMAIS faire `docker compose down -v`** : `-v` supprime le volume `./data`
> qui contient la base SQLite + la `master.key` Fernet. La configuration repart à zéro.

**Mise à jour** : `./update.sh` (sauvegarde `./data` → récupère la nouvelle version → recrée →
migrations auto, données préservées ; rollback affiché si besoin). Détails : [`docs/install.md`](docs/install.md#mise-à-jour).

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

Détail des suites de tests et conventions qualité : [`docs/testing.md`](docs/testing.md).

---

## Stack

| Couche | Technologies |
|---|---|
| **Backend** | Python 3.13+, FastAPI, SQLModel (SQLite → Postgres-ready), Alembic, Pydantic v2, APScheduler, cryptography (Fernet), httpx |
| **Frontend** | React 19, Vite 6, Tailwind v4, React Router 7, i18n FR/EN |
| **Qualité** | ruff, Biome, pytest + respx, Vitest + Testing Library, Playwright |
| **Infra** | Docker multi-stage, docker-compose, conteneur non-root, volume `./data` |

---

## Sécurité & RGPD

- **On-premise**, aucun phone-home, aucun appel sortant hors fournisseur LLM configuré.
- **Secrets chiffrés Fernet** au repos ; `master.key` montée comme volume Docker (`0600`).
- **Pas de PII en clair** envoyée au LLM (masquage avant l'appel ; logs reflètent le masquage).
- **Pas de métrique nominative** par technicien (anti-mouchard).
- **Conteneur non-root**, rate-limit login (avec `X-Forwarded-For` derrière proxy).
- **Export CSV DPO** + rétention RGPD automatisée.

Détails : [`SECURITY.md`](SECURITY.md) (politique de divulgation) · [`docs/dpo.md`](docs/dpo.md) (fiche DPO) · [`docs/llm-providers.md`](docs/llm-providers.md) (souveraineté par fournisseur).

---

## Documentation

| | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Pipeline immuable, structure hexagonale, pourquoi ce produit |
| [`docs/features.md`](docs/features.md) | Fonctionnalités détaillées (whitelist curée, fiches en prose, etc.) |
| [`docs/modes.md`](docs/modes.md) | Modes d'exécution (`suggestion` / `semi_auto` / `full_auto`) |
| [`docs/llm-providers.md`](docs/llm-providers.md) | 4 fournisseurs LLM + souveraineté |
| [`docs/glpi-api-v2.md`](docs/glpi-api-v2.md) | Connecteur GLPI API V2 (OAuth2, GLPI 11) — **Beta** |
| [`docs/postgresql.md`](docs/postgresql.md) | Portage PostgreSQL (driver, pool, compose) — **Beta** |
| [`docs/enterprise-upgrade.md`](docs/enterprise-upgrade.md) | Passer en édition Enterprise sans rien perdre (open-core) |
| [`docs/api.md`](docs/api.md) | Référence des endpoints REST |
| [`docs/testing.md`](docs/testing.md) | Suites de tests + CI |
| [`docs/install.md`](docs/install.md) | Installation on-prem en ½ page |
| [`docs/dpo.md`](docs/dpo.md) | Fiche DPO 1 page (validation RGPD) |
| [`docs/spike.md`](docs/spike.md) | Spike Epic 1 — protocole et résultats |
| [`docs/project-context.md`](docs/project-context.md) | Invariants non-négociables (à lire avant de coder) |
| [`docs/roadmap.md`](docs/roadmap.md) | Pistes ouvertes |
| [`docs/design/`](docs/design/) | Specs design (palette de couleurs, cartes) |
| [`CHANGELOG.md`](CHANGELOG.md) | Historique des changements |
| [`SECURITY.md`](SECURITY.md) | Politique de sécurité et divulgation |

---

## Éditions (open-core)

Ce dépôt est l'**édition Community** (le cœur, MIT) : triage à garde-fous, connecteurs GLPI **legacy + V2**, PostgreSQL, masquage PII de base, modes par entité. Tout est fonctionnel et gratuit.

L'**édition Enterprise** ajoute, par-dessus la même base, des fonctionnalités payantes débloquées par une **clé de licence signée (Ed25519, vérifiée hors-ligne — zéro phone-home, compatible air-gap)** : masquage PII avancé (NIR/SIRET, regex custom), multi-entités avancé, exports planifiés / DPO+. Ces options apparaissent dans la console (page **Store**) mais restent **verrouillées** sans licence — leur code n'est pas livré dans l'édition Community (garantie de séparation).

**Passer en Enterprise** sans rien perdre (même `./data`, swap d'image + licence) : [`docs/enterprise-upgrade.md`](docs/enterprise-upgrade.md) ou `./upgrade-to-enterprise.sh`.

## Licence

[MIT](LICENSE) — open-core, monétisation par le service (support SLA, install/config, prestations, modules Enterprise). 

---

<div align="center">

Conçu pour les DSI qui veulent **garder la main** : le LLM propose, le code décide.

</div>
