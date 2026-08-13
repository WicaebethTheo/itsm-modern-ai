<div align="center">

<img src="frontend/public/favicon.svg" width="84" alt="ITSM Modern AI" />

# ITSM Modern AI

Triage automatique des tickets GLPI par un LLM, sous contrôle déterministe du code.
On-premise, souverain, open-core.

*Automated GLPI ticket triage with an LLM kept behind deterministic guardrails.*

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.81-blueviolet)](pyproject.toml)
[![GHCR image](https://img.shields.io/badge/GHCR-image_publique-2496ED?logo=github&logoColor=white)](https://github.com/WicaebethTheo/itsm-modern-ai/pkgs/container/itsm-modern-ai)
[![Python 3.13+](https://img.shields.io/badge/Python-3.13+-3776AB?logo=python&logoColor=white)](pyproject.toml)

[Déploiement](#déploiement) · [Fonctionnement](#fonctionnement) · [Documentation](https://docs.itsm-modern-ai.com) · [Site produit](https://itsm-modern-ai.com)

</div>

---

## Le problème

GLPI traite bien les tickets structurés : les règles métier suffisent quand la catégorie et
le demandeur sont posés. Reste la queue longue — tickets flous, mal formulés, sans champ
exploitable — qui atterrit dans une file « à trier » que personne ne vide.

ITSM Modern AI prend cette file en charge. Un LLM lit le ticket et propose une décision ;
le code la valide contre une liste blanche et un seuil de confiance avant toute écriture
dans GLPI. Le LLM ne décide jamais seul, et un ticket sur lequel le doute subsiste retourne
« à trier » — c'est la seule échappatoire du pipeline.

Le moteur tourne chez vous. Hors du fournisseur LLM que vous configurez et de votre GLPI,
la seule sortie réseau est la vérification de version, désactivable.

---

## Déploiement

Image publique GHCR multi-arch (amd64 + arm64), *pull-only* : ni clone, ni build.
`ghcr.io/wicaebeththeo/itsm-modern-ai`

| Tag | Contenu | Usage |
|---|---|---|
| `latest` | dernière version publiée (release) | recommandé |
| `X.Y.Z` / `X.Y` | version figée | épinglage |
| `edge` | état intégré de `main`, entre deux releases | lab uniquement |

`latest` ne bouge que sur une release : un merge dans `main` ne change rien pour vous.
Pour tester une préversion, remplacez `:latest` par `:edge` sur une instance de lab avec
son propre volume. Les retours sur `edge` permettent d'attraper un problème avant qu'il
n'atteigne `latest`.

### Installer

```bash
curl -fsSL https://itsm-modern-ai.com/install | bash
```

Ou par Docker Compose — deux services, le moteur et sa base PostgreSQL, seule base
supportée. Ce fichier se colle tel quel dans Portainer.

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
    image: postgres:17-alpine                    # majeure épinglée — un bump n'est pas anodin
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

La console écoute sur `http://HOST:8000`. Mise à jour : `docker compose pull && docker
compose up -d` — les migrations Alembic sont appliquées au démarrage.

Stack durcie (capabilities, read-only, healthcheck) :
[`docker-compose.portainer.yml`](docker-compose.portainer.yml). Pour `docker run`, un build
local ou une installation hors-ligne : [`install.sh`](install.sh) et la
[documentation de déploiement](https://docs.itsm-modern-ai.com/production-deployment/).

### Première visite

Aucun mot de passe n'est à préparer. Le premier écran demande une adresse email et un mot
de passe d'au moins 8 caractères : c'est le compte administrateur unique. Le hash Argon2 est
chiffré dans le volume ; aucun mot de passe en clair n'existe nulle part.

> **N'exposez pas le port avant d'avoir créé ce compte.** Entre le démarrage du conteneur et
> cette création, quiconque atteint le port peut revendiquer l'administration de l'instance.
> L'absence de jeton d'amorçage et de fenêtre temporelle est un choix délibéré : le prix
> aurait été un secret à transporter, ce que cette version supprime précisément. Tant
> qu'aucun compte n'existe, le moteur le répète à chaque démarrage dans ses logs
> (`AUCUN COMPTE ADMINISTRATEUR : cette instance est REVENDICABLE`).

Il n'y a pas de réinitialisation par email — le produit ne parle à aucun serveur SMTP. La
reprise en main se fait depuis l'hôte, voir [plus bas](#mot-de-passe-administrateur-oublié).

### Sauvegarder

Avant toute mise à jour :

```bash
docker compose exec itsm python -m itsm_modern_ai.backup
```

Le dump `pg_dump` est pris à chaud puis relu intégralement — structure et comptage des
lignes — et accompagné de la `master.key`, sans laquelle une restauration est illisible. Ne
copiez jamais le répertoire de données d'un serveur en marche : le cluster obtenu est
incohérent.

> **Jamais `docker compose down -v`.** L'option `-v` supprime `itsm_data` (la clé de
> chiffrement) et `itsm_pgdata` (toutes les données).

### Ce que PostgreSQL coûte

Un second conteneur à superviser et à mettre à jour, environ 250 Mio de RAM réservés pour
lui (plafonnés à 1 Gio par la stack durcie, contre 512 Mio pour le moteur), un second volume
sans lequel une sauvegarde ne restaure rien, et une majeure épinglée à 17 dont la montée
exigera un `pg_dump` / `pg_restore` — le répertoire de données d'une majeure n'est pas
lisible par la suivante. Le détail du coût, du gain et de la procédure est dans la
[documentation PostgreSQL](https://docs.itsm-modern-ai.com).

---

## Configuration

Toutes les variables sont optionnelles. Le compte administrateur ne s'amorce plus par
variable d'environnement : il se crée à la première visite, et le moteur ne lit aucun mot de
passe dans l'environnement. Les clés LLM et les jetons GLPI se saisissent dans l'interface,
chiffrés Fernet au repos — jamais ici.

| Variable | Défaut | Rôle |
|---|---|---|
| `SESSION_HTTPS_ONLY` | `true` | Cookie de session `Secure`. Défaut code `true` ; les artefacts livrés (`.env` de l'installeur, compose Portainer) posent `false` pour le pilote HTTP, sinon le login est impossible. Repasser à `true` derrière un TLS. |
| `ITSM_HOST_PORT` | `8000` | Port hôte publié (installeur / `docker-compose.portainer.yml`). |
| `POSTGRES_USER` · `POSTGRES_PASSWORD` · `POSTGRES_DB` | `itsm` · `itsm` · `itsm` | Identifiants créés à l'initialisation du cluster, au premier démarrage seulement — ensuite, `ALTER USER`. |
| `ITSM_DATABASE_URL` | `postgresql+psycopg://itsm:itsm@postgres:5432/itsm` | URL de la base sous compose : les composes livrés la posent dans `environment:` sous le nom `DATABASE_URL`. Doit rester cohérente avec les trois variables ci-dessus. |
| `DATABASE_URL` | `postgresql+psycopg://itsm:itsm@localhost:5432/itsm` | Lue directement par le moteur, hors compose (`docker run`, `make run`, `make migrate`). Sous compose, la valeur de `.env` est écrasée par le bloc `environment:` — utilisez `ITSM_DATABASE_URL`. |
| `LICENSE_KEY` | *(vide)* | Clé Supporter. Vide = Community ; se colle aussi dans l'interface. |
| `MASTER_KEY` | *(auto)* | Clé Fernet du chiffrement au repos, générée dans le volume au premier démarrage si vide. |
| `TRUST_PROXY_HEADERS` | `false` | Lit `X-Forwarded-For` derrière un reverse proxy. |
| `UPDATE_CHECK_URL` | *(GitHub)* | Vérification de version. Vider la variable la désactive (air-gap). |
| `DEV_OPEN_ADMIN` | `false` | Ouvre l'administration **sans mot de passe**. Développement uniquement. |

Référence complète : [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com).

---

## Fonctionnement

```text
 GLPI ──poll──▶ Masquage PII ──▶ LLM (proposition) ──▶ Validation déterministe ──▶ GLPI
                                                       │ whitelist + seuil de confiance
                                                       ▼
                                       sous le seuil / hors liste ─▶ « à trier »
```

L'ordre de ce pipeline n'est jamais réordonné ni court-circuité : aucune action n'atteint
GLPI sans être passée par la validation du code. Les données personnelles sont masquées
avant l'appel au LLM, chaque décision est tracée dans un journal d'audit, et la dépense LLM
est plafonnée par un cost cap glissant sur 24 heures.

Architecture détaillée : [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com).

---

## Fonctionnalités

- **Triage à garde-fous** — proposition du LLM filtrée par liste blanche et seuil de
  confiance, repli « à trier ».
- **Connecteurs GLPI** — API *legacy* (`apirest.php`) et API V2 (OAuth2).
- **Choix du fournisseur LLM** — Mistral EU par défaut, OpenAI, Anthropic, ou Ollama en
  local intégral.
- **Masquage des données personnelles** — email et téléphone toujours masqués avant le LLM ;
  catégories étendues sous licence Supporter.
- **Console DPO** — catalogue des catégories masquées, testeur de masquage, export d'un
  rapport DPO en Markdown.
- **Coûts et quotas** — dépense LLM glissante sur 24 heures face au plafond journalier.
- **Multi-entités** — mode de triage réglable par entité GLPI.
- **Persistance PostgreSQL** — livrée comme service de la stack, avec sauvegarde à chaud
  vérifiée et migrations Alembic appliquées au démarrage.
- **Sécurité par défaut** — conteneur non-root, accès administrateur *fail-closed*,
  limitation de débit sur le login, secrets chiffrés au repos.

---

## Sécurité et RGPD

**Sorties réseau.** Hors du fournisseur LLM configuré et de votre GLPI, la seule sortie est
la vérification de version. Elle est activée par défaut, best-effort, déclenchée quand un
administrateur authentifié charge la console (cache d'une heure). Elle lit uniquement le
dernier numéro de version publié sur `api.github.com` et n'envoie aucune donnée de
l'instance ; `UPDATE_CHECK_URL=` vide la désactive. La licence Supporter, elle, est vérifiée
hors-ligne en toutes circonstances : Ed25519, aucun serveur de licence.

**Masquage.** Email et téléphone sont masqués avant l'appel au LLM, activés par défaut —
mais ce sont deux bascules que l'administrateur peut éteindre depuis la page
Confidentialité, auquel cas les adresses partent en clair. IBAN et cartes,
secrets (mots de passe, jetons, clés d'API), IP et MAC, identifiants français (NIR, SIRET)
sont débloqués par une licence Supporter. **Sans licence, IBAN et secrets partent en clair
au LLM** — la console et le rapport DPO l'affichent l'un comme l'autre, plutôt que de le
taire.

**Secrets.** Chiffrés avec Fernet au repos ; la `master.key` vit dans le volume `itsm_data`
en `0600`. Aucune clé LLM ni jeton GLPI ne transite par `.env` en usage normal.

**Accès.** Conteneur non-root, administration *fail-closed*, limitation de débit sur le
login (avec `X-Forwarded-For` derrière un proxy) — le même compteur couvre la création du
compte, publique par construction. Tant qu'aucun compte n'existe, `POST /api/auth/setup` est
ouvert à quiconque atteint le port : c'est la fenêtre de revendication décrite plus haut.

**Pas de métrique nominative** par technicien : le produit ne mesure pas les personnes.
Export CSV pour la DPO et purge RGPD automatisée.

Détail et limites connues : [Sécurité & limites](https://docs.itsm-modern-ai.com/security-limits/).

### Mot de passe administrateur oublié

Il n'existe aucun envoi d'email de réinitialisation. La reprise en main se fait depuis
l'hôte : avoir un accès shell à la machine *est* le facteur d'authentification.

```bash
# Compose / Portainer — saisie masquée, l'adresse de connexion est conservée
docker compose exec itsm python -m itsm_modern_ai.admin_setup --force

# Depuis les sources
make set-admin-password            # ajoutez EMAIL=… si aucun compte n'existe encore
```

La même CLI accepte `--email a@b.fr --email-only` pour corriger l'adresse sans toucher au
mot de passe, et `--check` qui rend 0 si un compte existe, 1 sinon. Tout changement de mot
de passe révoque les sessions ouvertes. Si l'adresse est oubliée elle aussi,
`--force --email <nouvelle adresse>` réécrit les deux. Pour une installation depuis les
sources, `./install.sh --reset-password` fait la même chose.

---

## Éditions

Édition unique : un seul dépôt, une seule image. Tout le code est ici, sous licence MIT —
triage à garde-fous, connecteurs GLPI *legacy* et V2, PostgreSQL, masquage email et
téléphone, modes par entité — y compris les fonctions Supporter, dont le code est livré mais
verrouillé.

Ces fonctions se déverrouillent en place, par une clé de licence signée en Ed25519 et
vérifiée hors-ligne : aucun appel sortant, compatible air-gap. Elles couvrent le masquage
des IBAN et cartes, des secrets, des IP et MAC, et des identifiants NIR / SIRET. Les motifs
regex personnalisés, le multi-entités avancé et les exports planifiés sont annoncés dans la
console comme prévus, et le restent tant qu'ils ne sont pas livrés.

Pour activer une licence, collez la clé dans la page Supporter de la console : le
déverrouillage est immédiat, sans changement d'image ni perte de données. Retirer la clé sur
cette même page revient à l'édition Community. `LICENSE_KEY` dans `.env` reste un
pré-amorçage optionnel pour les déploiements automatisés. La clé privée de signature vit
dans un dépôt séparé ; seule la clé publique de vérification est embarquée ici.

[docs.itsm-modern-ai.com/supporter](https://docs.itsm-modern-ai.com/supporter/)

---

## Stack

| Couche | Technologies |
|---|---|
| Backend | Python 3.13+, FastAPI, SQLModel, PostgreSQL 17 (psycopg 3), Alembic, Pydantic v2, APScheduler, cryptography (Fernet), httpx |
| Frontend | React 19, Vite 8, Tailwind v4, React Router 7, i18n FR/EN |
| Qualité | ruff, Biome, pytest + respx, Vitest + Testing Library, Playwright |
| Infra | Docker multi-stage, image GHCR multi-arch, conteneur non-root, service `postgres:17-alpine`, volumes nommés `itsm_data` et `itsm_pgdata` |

---

## Développement local

Un PostgreSQL joignable est nécessaire, pour lancer le moteur comme pour lancer les tests :
la suite crée un schéma jetable par test. Le plus simple est un serveur jetable sur un port
décalé.

```bash
docker run -d --name itsm-test-pg -p 55432:5432 \
  -e POSTGRES_USER=itsm -e POSTGRES_PASSWORD=itsm -e POSTGRES_DB=itsm postgres:17-alpine
```

```bash
make install     # venv (uv) + dépendances Python
make migrate     # alembic upgrade head   (lit DATABASE_URL, défaut localhost:5432)
make ui          # build de la SPA (Node 24)
make run         # uvicorn + scheduler → http://localhost:8000
make test        # pytest (exige un serveur ; TEST_DATABASE_URL, défaut localhost:55432)

make ui-dev      # frontend en hot-reload (proxy /api → :8000) → http://localhost:5173
```

Suites de tests et conventions qualité : [documentation en ligne](https://docs.itsm-modern-ai.com).

---

## Documentation

Toute la documentation est en ligne : **[docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)**

Déploiement on-premise, architecture et pipeline, connecteurs GLPI (*legacy* et V2),
fournisseurs LLM et souveraineté, exploitation PostgreSQL (sauvegarde, montée de majeure),
modes d'exécution, fiche DPO, référence de l'API, et le guide
[Supporter](https://docs.itsm-modern-ai.com/supporter/).

---

## Licence

[MIT](LICENSE). Le modèle est open-core : tout le code applicatif est public dans ce dépôt,
la monétisation passe par le service — support avec SLA, installation et configuration,
prestations, licences Supporter. Seule la clé privée de signature des licences reste hors
dépôt.
