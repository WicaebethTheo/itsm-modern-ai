# Tests & qualité

> Les chemins critiques (pipeline, masquage, whitelist, cost cap, modes) sont **non-négociables** — couverts par des tests unitaires et d'intégration.

| Suite | Compte | Commande |
|---|---:|---|
| **pytest** (unit + integration via `respx`) | **652** | `make test` |
| **Vitest + Testing Library** (composants + pages) | **194** (26 fichiers) | `make ui-test` |
| **Playwright** (E2E, API mockée) | **7 parcours** (4 fichiers) | `make ui-e2e` |
| **ruff** (Python) | 0 violation | `make lint` |
| **Biome + tsc** (TS/JSX) | 0 violation | `make ui-lint` |

## Prérequis — un PostgreSQL joignable

**La suite backend ne tourne plus « à sec ».** PostgreSQL étant la seule base supportée, les
tests s'exécutent sur un **vrai serveur** : sans lui, `pytest` échoue immédiatement, avec un
message qui rappelle la commande ci-dessous.

```bash
docker run -d --name itsm-test-pg -p 55432:5432 \
  -e POSTGRES_USER=itsm -e POSTGRES_PASSWORD=itsm -e POSTGRES_DB=itsm \
  postgres:17-alpine
```

C'est une base **jetable** : elle ne contient rien qui doive survivre (`docker rm -f
itsm-test-pg` pour la supprimer). Le port **55432** est volontairement décalé du 5432
standard, pour ne pas entrer en conflit avec un PostgreSQL système ni avec une instance du
produit qui tournerait sur la même machine.

| Variable | Défaut | Rôle |
|---|---|---|
| `TEST_DATABASE_URL` | `postgresql+psycopg://itsm:itsm@localhost:55432/itsm` | Serveur visé par la suite. À définir pour viser une autre machine, un autre port, ou le service PostgreSQL de la CI. |

```bash
# viser un autre serveur
TEST_DATABASE_URL=postgresql+psycopg://user:pwd@hote:5432/base uv run pytest -q
```

> ⚠️ **Deux ports, deux variables — ne les confondez pas.** `TEST_DATABASE_URL` (défaut **55432**)
> ne concerne que `pytest`. `make run` et `make migrate` lisent `DATABASE_URL`, dont le défaut du
> code est **5432**. Le serveur jetable ci-dessus ne sert donc pas le moteur en dev : pour lancer
> `make migrate` / `make run` dessus, exportez explicitement
> `DATABASE_URL=postgresql+psycopg://itsm:itsm@localhost:55432/itsm` (ou publiez le conteneur sur
> le 5432).

**Un schéma jetable par test, pas une base par test.** `tests/conftest.py` crée un
`CREATE SCHEMA test_<uuid>` avant chaque test et le détruit après : même isolation qu'un
fichier de base neuf du temps de SQLite (aucune ligne, aucune séquence, aucun index partagés),
sans le coût d'un `CREATE DATABASE` — qui, en plus d'être bien plus lourd, ne peut pas tourner
dans une transaction. Le `search_path` est fixé **dans l'URL** (`options=-csearch_path=…`),
donc appliqué par libpq à l'établissement de **chaque** connexion : toute connexion du pool,
y compris celles ouvertes après coup sous un autre thread, voit le bon schéma — ce qu'un `SET`
émis après coup ne garantit pas.

> **Prenez bien la majeure 17**, pas « celle qui traîne ». C'est celle des deux composes, celle du
> `postgresql-client-17` embarqué dans l'image, et celle qu'impose la CI
> (`test_la_majeure_postgres_de_la_ci_suit_celle_du_produit`) : tester sur une autre validerait une
> combinaison que le produit ne livre pas. Concrètement, `tests/unit/test_backup.py` fait tourner le
> `pg_dump` de **votre poste** contre ce serveur — un client plus ancien que le serveur fait
> **sauter** (skip) ces tests, et un couple désaligné casse la restauration dans les deux sens.
> Sur un poste de dev, installez donc aussi le client à la même majeure
> (Debian/Ubuntu : `apt install postgresql-client-17`).

## Chemins critiques couverts

- Pipeline à ordre immuable (règles → cost cap → masquage → LLM → Pydantic → whitelist → seuil → Suivi / « à trier »).
- Sauvegarde (`tests/unit/test_backup.py`, contre un **vrai** PostgreSQL — pas un `pg_dump` simulé) : dump `pg_dump --format=custom` pris à chaud, archive **relue en deux temps** (structure par `pg_restore --list`, avec une entrée `TABLE DATA` exigée pour chaque table de la base ; puis relecture **intégrale** des données par `pg_restore --data-only` et recomptage ligne à ligne contre la base vive). Sont refusées : une archive vide, tronquée, à table manquante, ou dont une table peuplée en base ressort vide. `master.key` jointe, URL non-PostgreSQL rejetée, mot de passe jamais passé sur la ligne de commande (`PGPASSWORD`), aucun dossier laissé à moitié fait en cas d'échec.
- Contrats d'exploitation (`tests/unit/test_deployment_files.py`) : la base est un **service à part entière** des deux composes, le PGDATA ne partage pas le volume applicatif, l'entrypoint **attend la base avant de migrer** (attente bornée, échec explicite), `install.sh --rollback` **restaure réellement** la base (`pg_restore --exit-on-error`, **schéma remis à plat** au lieu de `--clean`, confirmation **tapée** et jamais auto-répondue, refus si l'état courant n'est pas dumpable, état d'avant conservé), la mise à jour **refuse** de partir sans sauvegarde, un **PGDATA d'une autre majeure** est refusé avec sa procédure (fonctions shell réellement exécutées sur un faux cluster, côté installeur **et** entrypoint), et la **majeure PostgreSQL** est la même dans les composes, le client de l'image et la CI.
- **Compte administrateur créé à la première visite** (`tests/unit/test_deployment_files.py`) : **aucune** trace d'`ITSM_ADMIN_PASSWORD` / `ADMIN_PASSWORD` dans les fichiers d'exploitation (composes, `.env.example`, `install.sh`, entrypoint, `Makefile`, `Dockerfile`, workflow de publication) — une variable résiduelle serait un **leurre**, l'exploitant la renseignerait sans effet et croirait son compte protégé ; l'entrypoint n'appelle plus `admin_setup` en écriture ; l'installeur n'oppose plus de porte dure « pas de mot de passe = refus de terminer » et **renvoie vers l'écran de création** en avertissant de ne pas exposer le port ; `--reset-password` et `make set-admin-password` **délèguent** à la CLI avec les bons drapeaux (`--force`, et `--email` quand aucun compte n'existe).
- **Publication d'image bloquée par le parcours réel** (`.github/workflows/docker-publish.yml`, verrouillé par le même module) : le smoke test **exerce** `POST /api/auth/setup` (200), son **rejeu** (409, *fail-closed*), puis `POST /api/auth/login` avec les identifiants créés (200) et `setup_required` repassé à faux. Il remplace un `grep` de log qui ne prouvait que l'existence d'une ligne — il serait resté vert avec un hash illisible ou un `/api/auth/login` cassé.
- Fenêtre de doublon du poller : réservation posée AVANT le handler, rendue si le triage est rejouable, libérée en fin de cycle ; une interruption n'est jamais rejouée et est signalée.
- Purge RGPD côté console : confirmation obligatoire **avant** toute suppression, annulation qui n'exécute rien, fenêtres réellement appliquées annoncées dans la confirmation (et non le brouillon non enregistré), échec remonté à l'admin.
- Suivi « non tranché » sur « à trier » : déposé sur un refus **arbitré** (dans les 3 modes, sans mutation, sans brouillon), **jamais** sur un motif rejouable (panne LLM, sortie invalide, cap) ; un GLPI en panne ne casse ni la journalisation ni le marquage « traité ».
- Congés : bornes incluses, sortie du périmètre effectif, expiration automatique, héritage des domaines par le remplaçant, un seul saut d'intérim (ni chaîne ni cycle), fuseau local, purge RGPD des seules absences terminées.
- Repli assigné sur un refus arbitré : route sans classer (aucun champ de triage), jamais en mode `suggestion`, groupe préféré au technicien, cible revalidée contre la whitelist à l'écriture, échec de repli non dégradant, `fallback_applied` distinct de `applied`.
- Masquage PII (email, téléphone, IBAN, mot de passe/token).
- Whitelist (catégorie/priorité/technicien/groupe hors périmètre → « à trier »).
- Seuil de confiance + 2ᵉ seuil strict pour `semi_auto`.
- Cost cap glissant (cap atteint → tickets suivants en « à trier »).
- 3 modes d'exécution (`suggestion` jamais de mutation ; `full_auto` mute + Suivi public ; `semi_auto` mute si confiance ≥ 2ᵉ seuil).
- Mode par entité (override du défaut global).
- Idempotence du polling (Ticket déjà traité jamais retraité).
- Secrets Fernet chiffrés au repos + jamais en clair en log.
- Rate-limit login (anti brute-force + support `X-Forwarded-For`).
- Rétention RGPD (purge périodique du Journal et des appels LLM).
- TypeDecorator `UtcDateTime` (colonnes `ts` timezone-aware pour le portage Postgres).

## CI

**GitHub Actions** (`.github/workflows/`) — GitHub est le seul forge de ce projet.

| Workflow | Déclencheur | Contenu |
|---|---|---|
| `ci.yml` | chaque **PR** + push `main` | `backend` (ruff + pytest sur **3.14 et 3.13**) · `migrations` (Alembic : base vide, base **peuplée**, aller-retour `downgrade`/`upgrade`) · `frontend` (Biome + tsc + Vitest + build Vite) · `docker-build` (image amd64, sans push) |
| `docker-publish.yml` | push `main` → `edge` ; **release** → `latest` + semver | Re-joue ruff + pytest, **smoke test** du conteneur (boot, `/health`, `/api/status`, **parcours de création du compte admin** : `setup` 200 → rejeu 409 → `login` 200, puis sauvegarde `pg_dump` réelle), puis build multi-arch amd64 + arm64 |
| `release.yml` | tag `v*.*.*` | Crée la release GitHub (c'est elle qui notifie les instances déployées) |
| `codeql.yml` | PR + push `main` + hebdo | Analyse statique de sécurité |
| `secret-scan.yml` | PR + push `main` + hebdo | gitleaks (dont l'historique complet, en hebdo) |
| `security-audit.yml` | hebdo + PR touchant un lockfile | `pip-audit` + `npm audit` |

> **Le client PostgreSQL du runner est installé, et l'étape est bloquante.** `tests/unit/test_backup.py`
> dumpe une vraie base avec le `pg_dump` de la machine ; celui d'`ubuntu-latest` est en 16 et
> refuse de dumper le service en 17. Les deux workflows installent donc `postgresql-client-17`
> (dépôt PGDG) **sans `continue-on-error`**, et ces tests **échouent** au lieu de s'ignorer
> quand la variable `CI` est présente. Sans les deux moitiés, la CI restait verte en ayant
> silencieusement sauté la seule vérification de la sauvegarde (`577 passed, 8 skipped`).

> **`main` ne déplace plus `latest`** (0.9.54). `latest` — ce que tire tout `docker compose pull` —
> ne bouge que sur une **release publiée**. Un merge dans `main` produit `edge` + `sha-<court>` :
> publier redevient un acte explicite. Qui veut suivre la pointe tire `:edge` en connaissance de cause.

### Couverture

Deux portes, en **cliquet** : elles empêchent l'érosion, elles ne prétendent pas que la
couverture soit suffisante.

| Suite | Mesure | Seuil | Commande |
|---|---:|---:|---|
| Backend | **88,0 %** de *branches* (90,0 % de lignes) | 85 % | `pytest --cov` |
| Frontend | **72,1 %** de *statements*, 62,6 % de branches | 65 / 56 / 65 | `npm run test:coverage` |

Deux choix de configuration qui font toute la différence :

- **Backend : `branch = true`.** Un `if` dont un seul côté est exercé compte comme couvert
  en mesure de lignes — or c'est là que se cachent les régressions (un garde-fou dont on ne
  teste jamais le refus).
- **Frontend : `coverage.include` explicite.** Par défaut Vitest ne mesure que les fichiers
  *chargés* par un test : un fichier sans test sort du **dénominateur** au lieu de compter
  pour 0. Écart mesuré : **81,6 % annoncé contre 69,0 % réel**. Un taux qui *monte* quand on
  supprime un test est pire que pas de taux du tout.

`Dashboard.tsx` et `Debug.tsx` restent non testés — assumé : affichage en lecture seule pour
le premier, outil désactivé par défaut en production (`DEBUG_TOOLS_ENABLED`) pour le second.
L'effort a été mis sur `Automations.tsx`, seul écran déclenchant une **suppression
définitive** de données (purge RGPD).

**E2E Playwright** : joués **en local** (`make ui-e2e`), pas en CI — ils y étaient déjà
non bloquants (`allow_failure`). À rebrancher dans `ci.yml` le jour où ils sont stabilisés.

## Outils

- **uv** pour la gestion des dépendances Python (rapide, déterministe).
- **respx** pour mocker les appels HTTP GLPI et LLM dans les tests.
- **Testing Library** pour les tests React (oriented user behavior).
- **Playwright** pour les E2E (3 parcours : login → dashboard, navigation → journal, login → sandbox).

## Voir aussi

- [`docs/architecture.md`](architecture.md) — ce qui est testé et pourquoi.
- [`docs/project-context.md`](project-context.md) — invariants à préserver.
