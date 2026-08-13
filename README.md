<div align="center">

<img src="frontend/public/favicon.svg" width="84" alt="ITSM Modern AI" />

# ITSM Modern AI

**Moteur de triage IA des tickets GLPI — souverain, à garde-fous, on-premise.**

*The LLM proposes, the code decides — GLPI ticket triage with deterministic guardrails.*

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.80-blueviolet)](pyproject.toml)
[![GHCR image](https://img.shields.io/badge/GHCR-image_publique-2496ED?logo=github&logoColor=white)](https://github.com/WicaebethTheo/itsm-modern-ai/pkgs/container/itsm-modern-ai)
[![Docker multi-arch](https://img.shields.io/badge/docker-amd64_·_arm64-2496ED?logo=docker&logoColor=white)](docker-compose.portainer.yml)
[![Python 3.13+](https://img.shields.io/badge/Python-3.13+-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![Tests](https://img.shields.io/badge/tests-679_pytest_·_433_vitest-success)](https://docs.itsm-modern-ai.com)
[![Sovereign](https://img.shields.io/badge/sovereign-Mistral_EU_par_défaut-6B46C1)](https://docs.itsm-modern-ai.com)

[Déploiement](#déploiement) · [Comment ça marche](#comment-ça-marche) · [Documentation](https://docs.itsm-modern-ai.com) · [Site produit](https://itsm-modern-ai.com)

</div>

---

## En bref

GLPI gère bien les tickets structurés. **ITSM Modern AI** prend en charge le reste — la *« queue longue »* : tickets flous, mal formulés, sans champ posé. Le **LLM propose**, le **code valide et décide** : liste blanche déterministe, seuil de confiance, masquage PII avant tout appel LLM, et un fallback unique *« à trier »* quand le doute subsiste.

- 🔒 **Souverain & on-premise** — Mistral EU par défaut, ou 100 % local (Ollama). Une seule sortie réseau en plus du fournisseur LLM configuré : la vérification de version (activée par défaut, lit le dernier numéro de version publié, n'envoie aucune donnée), coupée par `UPDATE_CHECK_URL=` vide pour un air-gap total.
- 🛡️ **À garde-fous** — le LLM ne décide jamais seul : whitelist + seuil de confiance + validation par le code.
- 🧩 **Open-core MIT** — une seule image, tout le code livré ; les fonctions **Supporter** se déverrouillent en place par une licence **Ed25519 vérifiée hors-ligne**.
- 🐳 **Déploiement *pull-only*** — image GHCR multi-arch (amd64 + arm64), prête pour Portainer, `docker run` ou le one-liner. Ni clone, ni build.

---

## Déploiement

Image publique GHCR multi-arch, **pull-only** (ni clone ni build) : `ghcr.io/wicaebeththeo/itsm-modern-ai:latest`.

| Tag | Contenu | Pour qui |
|---|---|---|
| **`latest`** | dernière version **publiée** (release) | **défaut recommandé** |
| `X.Y.Z` / `X.Y` | version figée | qui veut épingler |
| `edge` | **préversion** : état intégré et testé de `main`, entre deux releases | lab, avant-première — jamais en production |

`latest` ne bouge **que** sur une release : un merge dans `main` ne change rien pour vous.
Tester la préversion = remplacer `:latest` par `:edge` dans le compose ci-dessous, sur une
instance de lab avec son propre volume. Les retours sur `edge` sont bienvenus — c'est le
canal qui permet d'attraper un problème avant qu'il n'atteigne `latest`.

**En une commande :**

```bash
curl -fsSL https://itsm-modern-ai.com/install | bash
```

**Ou via Docker Compose** (à coller dans Portainer ou `docker compose up -d`) — **deux services** : le moteur et sa base **PostgreSQL**, seule base supportée.

```yaml
services:
  itsm:
    image: ghcr.io/wicaebeththeo/itsm-modern-ai:latest
    depends_on:
      postgres: { condition: service_healthy }   # une base qui démarre n'accepte pas encore de connexion
    ports: ["8000:8000"]
    environment:
      SESSION_HTTPS_ONLY: "false"                # true derrière un reverse proxy TLS
      DATABASE_URL: postgresql+psycopg://itsm:change-me-too@postgres:5432/itsm
    volumes: ["itsm_data:/app/data"]             # master.key + sauvegardes
    restart: unless-stopped
  postgres:
    image: postgres:17-alpine                    # majeure ÉPINGLÉE — un bump n'est pas anodin
    environment:
      POSTGRES_USER: itsm
      POSTGRES_PASSWORD: change-me-too           # doit correspondre à DATABASE_URL ci-dessus
      POSTGRES_DB: itsm
    volumes: ["itsm_pgdata:/var/lib/postgresql/data"]   # les données
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U itsm -d itsm"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
    restart: unless-stopped
volumes:
  itsm_data:
  itsm_pgdata:
```

Console : **`http://HOST:8000`** · **Mise à jour :** `docker compose pull && docker compose up -d` (migrations Alembic appliquées au démarrage).

### Première visite : vous créez votre compte

Il n'y a **aucun mot de passe à préparer** : ouvrez `http://HOST:8000`, le premier écran vous demande une **adresse email** et un **mot de passe** (≥ 8 caractères). C'est le compte administrateur unique, et il est créé **en place** — le hash Argon2 est chiffré dans le volume, aucun mot de passe en clair n'existe nulle part.

> ### ⚠️ À lire avant d'ouvrir le port
> Entre le démarrage du conteneur et la création de ce compte, **quiconque atteint le port peut revendiquer l'administration de l'instance.** Le choix de ne poser **ni jeton d'amorçage ni fenêtre temporelle** est délibéré : le prix aurait été un secret à transporter, exactement ce que cette version supprime. Conséquence pratique : **n'exposez pas le port publiquement avant d'avoir créé votre compte.** Tant qu'il n'existe pas, le moteur le répète à chaque démarrage dans ses logs (`AUCUN COMPTE ADMINISTRATEUR : cette instance est REVENDICABLE`).

**Mot de passe oublié ?** La console n'envoie pas d'email : la récupération se fait depuis l'hôte, avec un accès au conteneur (voir plus bas).

**Sauvegarde** (avant toute mise à jour) : `docker compose exec itsm python -m itsm_modern_ai.backup` — dump `pg_dump` **à chaud** et **relu intégralement** (structure + comptage des lignes), accompagné de la `master.key` sans laquelle une restauration est illisible. Ne copiez jamais le répertoire de données d'un serveur en marche : le cluster obtenu est incohérent.

> ⚠️ Jamais `docker compose down -v` — `-v` supprime `itsm_data` (clé de chiffrement) **et** `itsm_pgdata` (toutes les données).

**Ce que la base coûte, dit franchement :** un **second conteneur** à superviser et à mettre à
jour, **~250 Mio de RAM** réservés pour lui (plafonné à 1 Gio par la stack durcie, contre 512 Mio
pour le moteur), un **second volume** sans lequel une sauvegarde ne restaure rien, et une
**majeure PostgreSQL épinglée** (17) dont la montée exigera un `pg_dump`/`pg_restore` — le
répertoire de données d'une majeure n'est pas lisible par la suivante. Détail du coût, du gain et
de la procédure : **[doc PostgreSQL](https://docs.itsm-modern-ai.com)**.

Stack **durci** (caps, read-only, healthcheck) → [`docker-compose.portainer.yml`](docker-compose.portainer.yml) · `docker run`, **build local / hors-ligne (air-gap)** via [`install.sh`](install.sh) → **[doc déploiement](https://docs.itsm-modern-ai.com/production-deployment/)**.

## Variables d'environnement

**Toutes optionnelles.** Le compte administrateur ne s'amorce **plus** par une variable : il se crée à la première visite (ci-dessus), et le moteur ne lit **aucun** mot de passe dans l'environnement. Les clés LLM et tokens GLPI se saisissent **dans l'interface** (chiffrés Fernet au repos), jamais ici.

| Variable | Défaut | Rôle |
|---|---|---|
| `SESSION_HTTPS_ONLY` | `true` | Cookie de session `Secure`. Défaut code `true` ; les artefacts livrés (`.env` de l'installeur, compose Portainer) posent `false` pour le pilote HTTP (sinon login impossible). Repasser à `true` derrière un TLS. |
| `ITSM_HOST_PORT` | `8000` | Port hôte publié (installeur / `docker-compose.portainer.yml`). |
| `POSTGRES_USER` · `POSTGRES_PASSWORD` · `POSTGRES_DB` | `itsm` · `itsm` · `itsm` | Identifiants créés à l'**initialisation du cluster** (premier démarrage seulement — ensuite, `ALTER USER`). |
| `ITSM_DATABASE_URL` | `postgresql+psycopg://itsm:itsm@postgres:5432/itsm` | URL de la base **sous compose** : les composes livrés la posent dans `environment:` sous le nom `DATABASE_URL`. Doit rester **cohérente** avec les trois variables ci-dessus. |
| `DATABASE_URL` | `postgresql+psycopg://itsm:itsm@localhost:5432/itsm` | Lue directement par le moteur (hors compose : `docker run`, `make run`, `make migrate`). ⚠️ Sous compose, la valeur de `.env` est **écrasée** par le bloc `environment:` — utilisez `ITSM_DATABASE_URL`. |
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
- **Persistance** — **PostgreSQL** (seule base supportée), livrée comme service de la stack : sauvegarde à chaud vérifiée, migrations Alembic appliquées au démarrage.
- **Sécurité par défaut** — conteneur non-root, fail-closed sur l'admin, rate-limit login, secrets chiffrés au repos.

---

## Sécurité & RGPD

- **On-premise** : hors du fournisseur LLM configuré, la seule sortie réseau est la **vérification de version** — **activée par défaut**, best-effort, déclenchée quand un admin authentifié charge la console (cache 1 h). Elle lit uniquement le dernier numéro de version publié sur `api.github.com` et **n'envoie aucune donnée** de l'instance. `UPDATE_CHECK_URL=` (vide) la désactive → **100 % hors-ligne**. La licence Supporter, elle, est vérifiée hors-ligne en toutes circonstances (Ed25519, aucun serveur de licence).
- **Secrets chiffrés Fernet** au repos ; `master.key` dans le volume `itsm_data` (`0600`).
- **Masquage PII avant le LLM** : e-mail + téléphone toujours inclus ; IBAN/cartes, secrets (mots de passe/tokens/clés API), IP/MAC et identifiants FR (NIR/SIRET) débloqués par une licence **Supporter**. ⚠️ Sans licence, IBAN et secrets partent **en clair** au LLM (avertissement affiché en console + fiche DPO).
- **Console DPO** dédiée : tableau des catégories masquées, testeur de masquage, export d'un rapport DPO pour validation en réunion.
- **Conteneur non-root**, *fail-closed* sur l'accès admin, rate-limit login (avec `X-Forwarded-For` derrière proxy) — le même compteur couvre la **création** du compte, qui est publique par construction.
- **Fenêtre de revendication assumée** : tant qu'aucun compte n'existe, `POST /api/auth/setup` est ouvert à quiconque atteint le port. Ni jeton d'amorçage, ni fenêtre temporelle — le choix est délibéré et **annoncé à chaque démarrage** dans les logs. N'exposez pas le port avant d'avoir créé votre compte.

### Mot de passe administrateur oublié

Il n'existe **aucun** envoi d'email de réinitialisation (le produit ne parle à aucun serveur SMTP, par souveraineté). La reprise en main se fait depuis l'hôte — **avoir un accès shell à la machine EST le facteur d'authentification** :

```bash
# Déploiement compose / Portainer (saisie masquée, l'adresse de connexion est conservée)
docker compose exec itsm python -m itsm_modern_ai.admin_setup --force

# Depuis les sources
make set-admin-password            # ajoutez EMAIL=… si aucun compte n'existe encore
```

Autres usages de la même CLI : `--email a@b.fr --email-only` (corriger l'adresse sans toucher au mot de passe), `--check` (0 si un compte existe, 1 sinon). Tout changement de mot de passe **révoque les sessions ouvertes**. Adresse **oubliée** aussi ? `--force --email <nouvelle adresse>` réécrit les deux.

> `./install.sh --reset-password` fait la même chose pour une installation depuis les sources.
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
| **Backend** | Python 3.13+, FastAPI, SQLModel + **PostgreSQL 17** (psycopg 3), Alembic, Pydantic v2, APScheduler, cryptography (Fernet), httpx |
| **Frontend** | React 19, Vite 6, Tailwind v4, React Router 7, i18n FR/EN |
| **Qualité** | ruff, Biome, pytest + respx, Vitest + Testing Library, Playwright |
| **Infra** | Docker multi-stage, image GHCR multi-arch, conteneur non-root, service `postgres:17-alpine`, volumes nommés `itsm_data` + `itsm_pgdata` |

---

## Développement local

**Il faut un PostgreSQL joignable** — pour lancer le moteur *et* pour lancer les tests (la suite
crée un schéma jetable par test). Le plus simple, un serveur jetable sur un port décalé :

```bash
docker run -d --name itsm-test-pg -p 55432:5432 \
  -e POSTGRES_USER=itsm -e POSTGRES_PASSWORD=itsm -e POSTGRES_DB=itsm postgres:17-alpine
```

```bash
make install     # venv (uv) + deps Python (psycopg inclus — plus d'extra à ajouter)
make migrate     # alembic upgrade head   (lit DATABASE_URL, défaut localhost:5432)
make ui          # build de la SPA (requiert Node 24 LTS)
make run         # uvicorn + scheduler → http://localhost:8000
make test        # pytest (exige un serveur ; TEST_DATABASE_URL, défaut localhost:55432)

make ui-dev      # frontend hot-reload (proxy /api → :8000) → http://localhost:5173
```

➜ Suites de tests et conventions qualité : **[documentation en ligne](https://docs.itsm-modern-ai.com)**

---

## Documentation

📖 **Toute la documentation est en ligne : [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)**

Déploiement on-prem, architecture (pipeline immuable), connecteurs GLPI (legacy + V2), fournisseurs LLM & souveraineté, base PostgreSQL (exploitation, sauvegarde, bump de majeure), modes d'exécution, fiche DPO/RGPD, référence API, et guide **[Supporter](https://docs.itsm-modern-ai.com/supporter/)**.

---

## Licence

[MIT](LICENSE) — open-core, monétisation par le service (support SLA, install/config, prestations, licences Supporter). Tout le code applicatif est public dans ce dépôt ; seule la clé privée de signature des licences reste hors dépôt.

---

<div align="center">

Conçu pour les DSI qui veulent **garder la main** : le LLM propose, le code décide.

**[Site produit](https://itsm-modern-ai.com)** · **[Documentation](https://docs.itsm-modern-ai.com)**

</div>
