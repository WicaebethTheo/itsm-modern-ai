<div align="center">

<img src="frontend/public/favicon.svg" width="84" alt="ITSM Modern AI" />

# ITSM Modern AI

**Moteur de triage IA des tickets GLPI — souverain, à garde-fous, on-premise.**

*The LLM proposes, the code decides — GLPI ticket triage with deterministic guardrails.*

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.46-blueviolet)](pyproject.toml)
[![GHCR image](https://img.shields.io/badge/GHCR-image_publique-2496ED?logo=github&logoColor=white)](https://github.com/WicaebethTheo/itsm-modern-ai/pkgs/container/itsm-modern-ai)
[![Docker multi-arch](https://img.shields.io/badge/docker-amd64_·_arm64-2496ED?logo=docker&logoColor=white)](docker-compose.portainer.yml)
[![Python 3.13+](https://img.shields.io/badge/Python-3.13+-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![Tests](https://img.shields.io/badge/tests-367_pytest_·_89_vitest-success)](https://docs.itsm-modern-ai.com)
[![Sovereign](https://img.shields.io/badge/sovereign-Mistral_EU_par_défaut-6B46C1)](https://docs.itsm-modern-ai.com)

[Déploiement](#déploiement) · [Comment ça marche](#comment-ça-marche) · [Documentation](https://docs.itsm-modern-ai.com) · [Site produit](https://itsm-modern-ai.com)

</div>

---

## En bref

GLPI gère bien les tickets structurés. **ITSM Modern AI** prend en charge le reste — la *« queue longue »* : tickets flous, mal formulés, sans champ posé. Le **LLM propose**, le **code valide et décide** : liste blanche déterministe, seuil de confiance, masquage PII avant tout appel LLM, et un fallback unique *« à trier »* quand le doute subsiste.

- 🔒 **Souverain & on-premise** — Mistral EU par défaut, ou 100 % local (Ollama). Aucun phone-home, aucun appel sortant hors fournisseur LLM configuré.
- 🛡️ **À garde-fous** — le LLM ne décide jamais seul : whitelist + seuil de confiance + validation par le code.
- 🧩 **Open-core MIT** — une seule image, tout le code livré ; les fonctions **Supporter** se déverrouillent en place par une licence **Ed25519 vérifiée hors-ligne**.
- 🐳 **Déploiement *pull-only*** — image GHCR multi-arch (amd64 + arm64), prête pour Portainer, `docker run` ou le one-liner. Ni clone, ni build.

---

## Déploiement

Image publique GHCR multi-arch, **pull-only** (ni clone ni build) : `ghcr.io/wicaebeththeo/itsm-modern-ai:latest`.

**En une commande :**

```bash
curl -fsSL https://itsm-modern-ai.com/install | bash
```

**Ou via Docker Compose** (à coller dans Portainer ou `docker compose up -d`) :

```yaml
services:
  itsm:
    image: ghcr.io/wicaebeththeo/itsm-modern-ai:latest
    ports: ["8000:8000"]
    environment:
      ITSM_ADMIN_PASSWORD: change-me-min-8   # ≥ 8 car. — amorce l'admin au 1er boot
      SESSION_HTTPS_ONLY: "false"            # true derrière un reverse proxy TLS
    volumes: ["itsm_data:/app/data"]
    restart: unless-stopped
volumes:
  itsm_data:
```

Console : **`http://HOST:8000`** · **Mise à jour :** `docker compose pull && docker compose up -d`.

> ⚠️ Jamais `docker compose down -v` — `-v` supprime le volume `itsm_data` (données + clé de chiffrement).

Stack **durci** (caps, read-only, healthcheck) → [`docker-compose.portainer.yml`](docker-compose.portainer.yml) · `docker run`, **build local / hors-ligne (air-gap)** via [`install.sh`](install.sh) → **[doc déploiement](https://docs.itsm-modern-ai.com/production-deployment/)**.

## Variables d'environnement

Toutes optionnelles **sauf `ITSM_ADMIN_PASSWORD` au 1er boot**. Les clés LLM et tokens GLPI se saisissent **dans l'interface** (chiffrés Fernet au repos), jamais ici.

| Variable | Défaut | Rôle |
|---|---|---|
| `ITSM_ADMIN_PASSWORD` | — | Mot de passe admin **amorcé au 1er boot** (≥ 8 car. ; alias accepté : `ADMIN_PASSWORD`). Idempotent, jamais écrasé, retirable ensuite. Sans lui : console **verrouillée** (*fail-closed*). |
| `SESSION_HTTPS_ONLY` | `true` | Cookie de session `Secure`. Défaut code `true` ; les artefacts livrés (`.env` de l'installeur, compose Portainer) posent `false` pour le pilote HTTP (sinon login impossible). Repasser à `true` derrière un TLS. |
| `ITSM_HOST_PORT` | `8000` | Port hôte publié (installeur / `docker-compose.portainer.yml`). |
| `DATABASE_URL` | SQLite (volume) | Base. PostgreSQL : `postgresql+psycopg://user:pwd@host:5432/itsm`. |
| `LICENSE_KEY` | *(vide)* | Clé Supporter (vide = Community ; collable aussi dans l'UI). |
| `MASTER_KEY` | *(auto)* | Clé Fernet de chiffrement au repos ; générée dans le volume au 1er boot si vide. |
| `TRUST_PROXY_HEADERS` | `false` | Lit `X-Forwarded-For` derrière un reverse proxy. |
| `UPDATE_CHECK_URL` | *(GitHub)* | Vérif de version (best-effort, lit le dernier tag). **Vider = désactivé** (air-gap). |
| `DEV_OPEN_ADMIN` | `false` | ⚠️ Ouvre l'admin **sans mot de passe** — dev/labo uniquement, jamais en prod. |

Référence complète : **[docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)**.

---

## Comment ça marche

```text
 GLPI ──poll──▶ Masquage PII ──▶ LLM (proposition) ──▶ Validation déterministe ──▶ GLPI
                                                       │ whitelist + seuil de confiance
                                                       ▼
                                       sous le seuil / hors liste ─▶ « à trier »
```

Le pipeline est **immuable** : aucune action n'est appliquée à GLPI sans avoir passé la validation par le code. Les PII sont masquées **avant** l'appel au LLM, chaque décision est tracée (journal d'audit), et la dépense LLM est plafonnée (page *Coûts & quotas*). Le LLM est une force de proposition — **la décision reste déterministe**.

➜ Architecture complète : **[docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)**

---

## Fonctionnalités

- **Triage à garde-fous** — proposition LLM filtrée par liste blanche + seuil de confiance, fallback « à trier ».
- **Connecteurs GLPI** — API *legacy* et **API V2**.
- **Souveraineté LLM** — Mistral EU (défaut), OpenAI, Anthropic, ou **Ollama 100 % local**.
- **Masquage PII** — e-mail + téléphone toujours masqués avant le LLM ; catégories étendues sous licence Supporter.
- **Console DPO / RGPD** — catalogue des PII masquées, testeur de masquage, **export d'un rapport DPO** (Markdown).
- **Coûts & quotas** — dépense LLM glissante sur 24 h vs plafond journalier.
- **Multi-entités** — modes de triage par entité GLPI.
- **Persistance** — SQLite par défaut, **PostgreSQL** prêt (profil compose dédié).
- **Sécurité par défaut** — conteneur non-root, fail-closed sur l'admin, rate-limit login, secrets chiffrés au repos.

---

## Sécurité & RGPD

- **On-premise**, aucun phone-home ; seul le fournisseur LLM configuré est appelé.
- **Secrets chiffrés Fernet** au repos ; `master.key` dans le volume `itsm_data` (`0600`).
- **Masquage PII avant le LLM** : e-mail + téléphone toujours inclus ; IBAN/cartes, secrets (mots de passe/tokens/clés API), IP/MAC et identifiants FR (NIR/SIRET) débloqués par une licence **Supporter**. ⚠️ Sans licence, IBAN et secrets partent **en clair** au LLM (avertissement affiché en console + fiche DPO).
- **Console DPO** dédiée : tableau des catégories masquées, testeur de masquage, export d'un rapport DPO pour validation en réunion.
- **Conteneur non-root**, *fail-closed* sur l'accès admin, rate-limit login (avec `X-Forwarded-For` derrière proxy).
- **Pas de métrique nominative** par technicien (anti-mouchard) · export CSV DPO + rétention RGPD automatisée.

➜ **[Sécurité & limites](https://docs.itsm-modern-ai.com/security-limits/)**

---

## Éditions (open-core)

Édition **UNIQUE** : un seul dépôt, une seule image. Tout le code est livré ici (MIT) — triage à garde-fous, connecteurs GLPI *legacy + V2*, PostgreSQL, masquage PII e-mail + téléphone, modes par entité — **plus** les fonctions **Supporter**, dont le code est présent mais **verrouillé**.

Les features Supporter se déverrouillent **en place** par une **clé de licence signée (Ed25519, vérifiée hors-ligne — zéro phone-home, compatible air-gap)** : masquage **IBAN/cartes + secrets + IP/MAC** et identifiants FR **NIR/SIRET**. *(Patterns regex personnalisés, multi-entités avancé et exports planifiés : sur la roadmap.)* Elles apparaissent dans la console (page **Supporter**) mais restent verrouillées tant qu'aucune licence valide n'est fournie. La clé de **signature** reste dans le dépôt privé dédié ; seule la clé publique de vérification est embarquée.

**Devenir Supporter** sans rien perdre (même volume `itsm_data`, aucun swap d'image) : **coller la clé de licence dans la page Supporter** de la console — déverrouillage en place. Pour revenir à Community, **retirer la clé** sur cette même page. `LICENSE_KEY` dans `.env` reste un pré-amorçage optionnel pour les déploiements automatisés.

➜ **[docs.itsm-modern-ai.com/supporter](https://docs.itsm-modern-ai.com/supporter/)**

---

## Stack

| Couche | Technologies |
|---|---|
| **Backend** | Python 3.13+, FastAPI, SQLModel (SQLite → PostgreSQL-ready), Alembic, Pydantic v2, APScheduler, cryptography (Fernet), httpx |
| **Frontend** | React 19, Vite 6, Tailwind v4, React Router 7, i18n FR/EN |
| **Qualité** | ruff, Biome, pytest + respx, Vitest + Testing Library, Playwright |
| **Infra** | Docker multi-stage, image GHCR multi-arch, conteneur non-root, volume nommé `itsm_data` |

---

## Développement local

```bash
make install     # venv (uv) + deps Python
make migrate     # alembic upgrade head
make ui          # build de la SPA (requiert Node 22)
make run         # uvicorn + scheduler → http://localhost:8000

make ui-dev      # frontend hot-reload (proxy /api → :8000) → http://localhost:5173
```

➜ Suites de tests et conventions qualité : **[documentation en ligne](https://docs.itsm-modern-ai.com)**

---

## Documentation

📖 **Toute la documentation est en ligne : [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)**

Déploiement on-prem, architecture (pipeline immuable), connecteurs GLPI (legacy + V2), fournisseurs LLM & souveraineté, portage PostgreSQL, modes d'exécution, fiche DPO/RGPD, référence API, et guide **[Supporter](https://docs.itsm-modern-ai.com/supporter/)**.

---

## Licence

[MIT](LICENSE) — open-core, monétisation par le service (support SLA, install/config, prestations, licences Supporter). Tout le code applicatif est public dans ce dépôt ; seule la clé privée de signature des licences reste hors dépôt.

---

<div align="center">

Conçu pour les DSI qui veulent **garder la main** : le LLM propose, le code décide.

**[Site produit](https://itsm-modern-ai.com)** · **[Documentation](https://docs.itsm-modern-ai.com)**

</div>
