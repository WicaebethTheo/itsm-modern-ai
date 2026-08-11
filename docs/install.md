# Installation on-premise (pilote V1)

> Déploiement **pilote** : **deux conteneurs** Docker — le moteur et sa base **PostgreSQL**,
> seule base supportée — **sans haute disponibilité** (un seul cluster, pas de réplication,
> pas de bascule). Ce n'est **pas** l'architecture de production. Voir la note « durcissement »
> en fin de page, et [`docs/postgresql.md`](postgresql.md) pour ce que ce choix coûte et
> apporte.

## Prérequis

- Une **VM Linux** avec **Docker** et **docker compose** (plugin v2).
- **~1,5 Gio de RAM** pour la stack et ~2 Gio de disque. Détail : la base **réserve 256 Mio**
  (le moteur 128 Mio) et est **plafonnée à 1 Gio** (le moteur à 512 Mio) — comptez donc ~250 Mio
  de plus qu'avant en régime normal, et dimensionnez sur les plafonds pour ne pas les toucher.
- Une instance **GLPI joignable** depuis la VM, avec un **`user_token` API** (auth `apirest.php`, plus un `App-Token` si la config serveur GLPI l'exige).
- Accès réseau sortant vers le **fournisseur LLM** configuré (Mistral EU par défaut).

> **Pas de clone ni de build** pour l'exploitant : on tire l'**image publique pré-construite**
> `ghcr.io/wicaebeththeo/itsm-modern-ai:latest` (multi-arch amd64+arm64, publiée par
> `.github/workflows/docker-publish.yml`). La voie « depuis les sources / hors-ligne » reste
> disponible plus bas pour l'airgap et le build local.

### Quel tag tirer ?

| Tag | Ce que c'est | Pour qui |
|---|---|---|
| **`latest`** | dernière version **publiée** (release). **Défaut recommandé.** | tout le monde |
| `X.Y.Z` / `X.Y` | version figée (ex. `0.10.0`, `0.10`) | qui veut épingler une version |
| `edge` | pointe de `main`, **entre deux releases** | tests, avant-première — jamais en production |
| `sha-<court>` | un commit précis de `main` | reproduction d'un incident |

`latest` ne bouge **que** sur une release publiée : un simple merge dans `main` ne modifie
rien pour un exploitant. Une mise à jour reste donc un acte volontaire de votre côté
(`docker compose pull && docker compose up -d`).

## Sauvegarde et restauration

**À faire avant toute mise à jour, et régulièrement.** Une sauvegarde complète, c'est **deux
choses indissociables** : le contenu de la base **et** la `master.key`. Sans cette clé, une
base restaurée est **définitivement illisible** (mot de passe admin, tokens GLPI et clé LLM
sont chiffrés avec). La commande livrée les prend ensemble :

```bash
docker compose exec itsm python -m itsm_modern_ai.backup
```

Produit `data/backups/AAAAMMJJ-HHMMSS/` contenant `itsm.dump` (archive `pg_dump` au format
`custom`) **et** `master.key`. Le dump est pris **à chaud**, sans arrêt de service :
`pg_dump` travaille dans une transaction à snapshot isolé, donc l'archive est cohérente même
si le poller écrit pendant ce temps.

L'archive est ensuite **relue et vérifiée**, en deux contrôles complémentaires :

1. **structure** — `pg_restore --list` relit l'en-tête et la table des matières ; une archive
   tronquée est refusée, et on exige une entrée `TABLE DATA` pour **chaque** table de la base ;
2. **contenu** — `pg_restore --data-only` décompresse l'intégralité des blocs de données et
   recompte les lignes table par table. Le premier contrôle seul validerait une archive
   structurellement saine mais **vide**.

En cas d'échec, la commande sort en erreur et supprime le dossier incomplet — une sauvegarde à
laquelle on ferait confiance à tort est pire que pas de sauvegarde.

> ⚠️ **Sortez la sauvegarde de l'hôte.** Elle est écrite dans le volume : un volume perdu
> emporte ses sauvegardes avec lui.
> `docker compose cp itsm:/app/data/backups ./sauvegardes`

**Pourquoi pas un simple `cp -a data/postgres`** : copier le répertoire de données d'un serveur
**en marche** produit un cluster incohérent — fichiers de données et WAL capturés à des
instants différents. La copie paraît réussir et se révèle irrécupérable le jour où l'on en a
besoin.

**Restauration.** Le moteur doit être **arrêté** (il écrirait dans une base en cours de
remplacement) ; la base, elle, reste **en marche** — on ne restaure pas dans un serveur éteint.

```bash
docker compose stop itsm
docker compose exec -T postgres psql -U itsm -d itsm -v ON_ERROR_STOP=1 \
    -c 'DROP SCHEMA IF EXISTS public CASCADE' -c 'CREATE SCHEMA public'
docker compose exec -T postgres pg_restore -U itsm -d itsm \
    --no-owner --exit-on-error < sauvegardes/20260811-162723/itsm.dump
cp -a sauvegardes/20260811-162723/master.key data/master.key   # si elle figure dans la sauvegarde
docker compose up -d itsm
```

Le **schéma est remis à plat** avant la restauration, et l'archive n'est **pas** rejouée avec
`pg_restore --clean` : `--clean` ne supprime que les objets **présents dans l'archive**. Une
table créée par une migration **postérieure** à la sauvegarde survivrait donc, pendant
qu'`alembic_version` serait rembobiné — la restauration paraîtrait réussir et c'est la **mise
à jour suivante** qui mourrait sur `relation "..." already exists`, dans un entrypoint en
`set -e`, donc en boucle de redémarrage. `--exit-on-error` arrête au premier problème : une
restauration à moitié faite est pire qu'une restauration refusée.

> Sur un **volume nommé** (Portainer), sans accès au fichier depuis l'hôte, on fait transiter
> l'archive d'un conteneur à l'autre (la remise à plat du schéma reste nécessaire) :
> ```bash
> docker compose exec -T postgres psql -U itsm -d itsm -v ON_ERROR_STOP=1 \
>   -c 'DROP SCHEMA IF EXISTS public CASCADE' -c 'CREATE SCHEMA public'
> docker compose exec -T itsm cat /app/data/backups/<horodatage>/itsm.dump \
>   | docker compose exec -T postgres pg_restore -U itsm -d itsm --no-owner
> ```

Depuis les sources, `./install.sh --rollback` fait tout cela **en une commande** (base + clé +
image + port publié) — voir « Restauration et retour arrière » plus bas.

## Installation (image GHCR, recommandé)

Trois voies, toutes **sans clone ni build**, et **aucun mot de passe à préparer** : le compte
administrateur se crée **à la première visite de l'interface** (adresse email + mot de passe
≥ 8 caractères). Il n'y a plus de variable `ITSM_ADMIN_PASSWORD` — le moteur ne lit **aucun**
mot de passe dans l'environnement.

> ## ⚠️ À lire AVANT de déployer — la fenêtre de revendication
>
> **Entre le démarrage du conteneur et la création de votre compte, quiconque atteint le port
> peut revendiquer l'administration de l'instance.** Le premier arrivé sur `http://<vm>:8000/`
> voit l'écran de création et devient l'administrateur.
>
> Le choix de ne poser **ni jeton d'amorçage ni fenêtre temporelle** est **délibéré**, au profit
> de la simplicité : l'un comme l'autre auraient réintroduit un secret à transporter — c'est
> précisément ce que cette version supprime.
>
> **Conséquence pratique : n'exposez pas le port publiquement avant d'avoir créé votre compte.**
> Déployez sur un réseau interne (ou avec le port fermé au pare-feu), ouvrez la console,
> créez le compte, **puis** publiez.
>
> Tant que le compte n'existe pas, le moteur le répète à **chaque démarrage** dans ses logs :
> ```
> AUCUN COMPTE ADMINISTRATEUR : cette instance est REVENDICABLE. …
> ```
> Cet avertissement disparaît une fois le compte créé — et sa création est journalisée avec
> l'IP d'origine. Si vous la voyez et que ce n'est pas la vôtre, l'instance a été prise :
> détruisez-la et repartez d'une base vierge.

**Ordre recommandé**, quelle que soit la voie choisie :

1. déployer avec le port **fermé** ou restreint (réseau interne, `127.0.0.1:8000:8000`, VPN) ;
2. ouvrir `http://<vm>:8000/` → l'écran d'installation demande **email + mot de passe** ;
3. vérifier dans les logs que l'avertissement « instance REVENDICABLE » a disparu ;
4. seulement ensuite, publier le service (reverse proxy TLS, règle de pare-feu).

### (a) One-liner (le plus simple)

```bash
curl -fsSL https://itsm-modern-ai.com/install | bash
```

Le script écrit un `docker-compose.yml` + un `.env`, tire les images et fait
`docker compose up -d`. La stack comprend **deux services** : le moteur et sa base PostgreSQL.
Il ne demande **aucun mot de passe** et se termine en affichant l'URL de l'écran de création
de compte : ouvrez `http://<vm>:8000/` et créez-le **tout de suite**.

### (b) Portainer / orchestrateur

Collez le contenu de **`docker-compose.portainer.yml`** dans un nouveau *stack* Portainer (ou votre
orchestrateur), puis déployez : **aucune variable n'est obligatoire**. Les images sont **tirées**
(aucun build) : le moteur depuis GHCR, la base depuis `postgres:17-alpine`. Ouvrez ensuite
`http://<hôte>:8000/` et **créez votre compte administrateur** (email + mot de passe) — c'est le
premier écran, et tant qu'il n'a pas été franchi l'instance est revendiquable par quiconque
atteint le port (cf. l'avertissement en tête de section).

Le stack crée **deux volumes nommés** : `itsm_data` (master.key, sauvegardes) et `itsm_pgdata`
(les données). Un `down -v` détruirait les deux — **ne jamais le faire**.

> **Mot de passe de la base.** Le défaut livré est `itsm`/`itsm`, suffisant sur un réseau de
> stack isolé (la base n'est publiée sur aucun port), pas ailleurs. Pour le changer, définissez
> **avant le tout premier déploiement** `POSTGRES_PASSWORD` **et** `ITSM_DATABASE_URL` avec la
> même valeur — les deux, sinon le moteur ne joint plus sa base. Après le premier démarrage,
> ces variables n'ont plus d'effet : le mot de passe se change alors par un
> `ALTER USER itsm PASSWORD '…'` dans la base.

Le stack utilise `${ITSM_IMAGE_TAG:-latest}`. Pour **épingler une version** — recommandé en
production, afin qu'un redéploiement ne tire pas silencieusement une version plus récente —
définissez `ITSM_IMAGE_TAG=0.10.0` dans les variables du stack. Sans cette variable, le
comportement reste `latest`.

### (c) `docker run` durci (deux conteneurs)

Ce n'est **plus une seule commande** : PostgreSQL étant la seule base supportée, il faut un
réseau, deux volumes et deux conteneurs. Si vous n'avez pas de raison précise d'éviter compose,
préférez la voie (a) ou (b) — ce qui suit est la transcription fidèle de ce que fait le compose
durci, pour qui déploie à la main ou scripte son orchestrateur.

```bash
# 1) Réseau privé + volumes (le PGDATA et la master.key sont SÉPARÉS : deux cycles de vie,
#    et le chown du volume applicatif ne doit jamais toucher au cluster).
docker network create itsm_net
docker volume create itsm_data
docker volume create itsm_pgdata

# 2) La base. Aucun -p : elle n'est joignable que depuis itsm_net.
docker run -d --name itsm-postgres \
  --network itsm_net \
  --restart unless-stopped \
  -e POSTGRES_USER=itsm \
  -e POSTGRES_PASSWORD='mot-de-passe-de-la-base' \
  -e POSTGRES_DB=itsm \
  -v itsm_pgdata:/var/lib/postgresql/data \
  --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges \
  --health-cmd 'pg_isready -U itsm -d itsm' \
  --health-interval 10s --health-timeout 5s --health-retries 5 --health-start-period 20s \
  postgres:17-alpine

# 3) Le moteur. DATABASE_URL doit porter EXACTEMENT les identifiants ci-dessus.
docker run -d --name itsm-modern-ai \
  --network itsm_net \
  --restart unless-stopped \
  -p 8000:8000 \
  -e DATABASE_URL='postgresql+psycopg://itsm:mot-de-passe-de-la-base@itsm-postgres:5432/itsm' \
  -e SESSION_HTTPS_ONLY=false \
  -v itsm_data:/app/data \
  --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp \
  ghcr.io/wicaebeththeo/itsm-modern-ai:latest
```

Points à ne pas manquer :

- **L'ordre n'a pas d'importance.** `docker run` n'a pas d'équivalent de `depends_on` :
  l'entrypoint du moteur **attend la base** (60 tentatives espacées de 2 s, réglables par
  `DB_WAIT_MAX_TRIES` / `DB_WAIT_DELAY`), applique `alembic upgrade head`, puis démarre. Au
  bout du plafond il sort en erreur, avec la dernière erreur de connexion — il ne reste pas
  bloqué en silence.
- **Le mot de passe apparaît deux fois** (à l'initialisation du cluster et dans
  `DATABASE_URL`) : toute divergence donne un moteur qui ne joint plus sa propre base. Les
  variables `POSTGRES_*` ne servent qu'au **premier** démarrage ; ensuite, changer le mot de
  passe demande un `ALTER USER`. Un mot de passe contenant `@ : / ? # %` doit être
  **encodé-URL** dans `DATABASE_URL` (`%40`, `%3A`, `%25`…).
- **`FOWNER` en plus côté base** : l'entrypoint officiel de PostgreSQL ajuste les droits du
  PGDATA au premier boot. Pas de `--read-only` non plus sur ce conteneur — PostgreSQL écrit
  hors de son PGDATA (socket, fichiers temporaires).
- `SESSION_HTTPS_ONLY=false` est nécessaire pour se connecter en **HTTP nu** (défaut code
  `true` → cookie `Secure` ignoré, login impossible). Repasser à `true` derrière un TLS.
- **Aucun mot de passe admin n'est passé au conteneur** — il n'en lit plus. Tant que vous
  n'avez pas créé votre compte dans l'interface, ce `-p 8000:8000` publie une instance
  **revendicable** : sur une machine exposée, publiez d'abord sur la boucle locale
  (`-p 127.0.0.1:8000:8000`), créez le compte, puis recréez le conteneur avec la
  publication définitive.

La **master key** et les sauvegardes vivent dans `itsm_data` (`/app/data`) ; les **données**
vivent dans `itsm_pgdata`. La `master.key` Fernet est générée automatiquement au premier
démarrage. Le moteur écoute sur le port **8000**.

Sauvegarder cette topologie (mêmes contrôles que sous compose, la commande vit dans l'image) :

```bash
docker exec itsm-modern-ai python -m itsm_modern_ai.backup
docker cp itsm-modern-ai:/app/data/backups ./sauvegardes      # sortir la copie de l'hôte
```

Et restaurer, moteur arrêté et base en marche :

```bash
docker stop itsm-modern-ai
docker exec -i itsm-postgres psql -U itsm -d itsm -v ON_ERROR_STOP=1 \
    -c 'DROP SCHEMA IF EXISTS public CASCADE' -c 'CREATE SCHEMA public'
docker exec -i itsm-postgres pg_restore -U itsm -d itsm \
    --no-owner --exit-on-error < sauvegardes/<horodatage>/itsm.dump
docker start itsm-modern-ai
```

(Même raison qu'au-dessus pour la remise à plat : `--clean` ne nettoierait que les objets
connus de l'archive, et laisserait en place les tables des migrations postérieures.)

## 3. Tout configurer dans l'interface web

Ouvrez l'**interface** sur **`http://<vm>:8000/`** (derrière le reverse proxy HTTPS en prod).

**Au tout premier accès**, l'écran d'installation vous demande une **adresse email** et un **mot
de passe** (≥ 8 caractères) : c'est la création du compte administrateur unique, et la session
s'ouvre dans la foulée — pas besoin de se reconnecter. Aux accès suivants, c'est l'écran de
connexion habituel (email + mot de passe). Toute la configuration se fait ensuite ici —
**aucun fichier à éditer** :

- **Connexion GLPI** : base URL `apirest.php`, **user token** (et app token si requis).
- **Fournisseur IA** : choisissez parmi **Mistral EU** (souverain, défaut), **OpenAI** (hors UE — à valider DPO), **Ollama** (modèle **local**, **pas de clé**) ou **Anthropic / Claude** (hors UE — à valider DPO) ; saisir la **clé API** (sauf Ollama).
- **Moteur** : seuil de confiance et cost cap.
- **Périmètre (scan GLPI puis sélection)** : lancez le **scan GLPI** (`POST /api/glpi/sync`) pour mettre en cache catégories, entités, techniciens et groupes, puis **sélectionnez** ce que l'IA a le droit d'utiliser — **catégories autorisées + entités** du périmètre, **techniciens/groupes éligibles** et leur **fiche en prose** (routage). Le moteur n'agit que dans ce périmètre effectif. **Plus de fichier YAML** : les fiches sont éditées dans l'UI et stockées en base.

Les **secrets** (clé LLM, tokens GLPI ; pas de clé pour Ollama) sont stockés **chiffrés au repos** (Fernet, FR-25) et ne sont **jamais** réaffichés ni mis dans `.env`.

> Équivalent en ligne de commande (l'UI consomme ce même endpoint `POST /api/config`) :
>
> ```bash
> curl -X POST http://localhost:8000/api/config -H 'Content-Type: application/json' -d '{
>   "glpi_base_url": "https://glpi.exemple.local/apirest.php",
>   "glpi_user_token": "xxxxx",
>   "llm_provider": "anthropic",
>   "anthropic_api_key": "sk-ant-…"
> }'
> ```

### Mot de passe administrateur oublié

C'est la première question que pose un exploitant à qui l'on retire la variable
d'environnement, alors répondons-y franchement : **il n'y a aucune réinitialisation par
email**. Le produit ne parle à aucun serveur SMTP — c'est une contrainte de souveraineté
assumée, pas un oubli. Le seul chemin de récupération est la **CLI livrée dans l'image**, ce qui
revient à dire que **l'accès shell à la machine hôte est le facteur d'authentification de
dernier recours** (quiconque l'a pouvait déjà lire `master.key` dans le volume : cette CLI
n'élargit pas la surface d'attaque).

```bash
# Compose / Portainer — nouveau mot de passe, l'adresse de connexion est conservée.
# Saisie MASQUÉE, avec confirmation ; le mot de passe n'apparaît ni à l'écran ni dans
# l'historique du shell. Les sessions ouvertes sont révoquées.
docker compose exec itsm python -m itsm_modern_ai.admin_setup --force

# docker run
docker exec -it itsm-modern-ai python -m itsm_modern_ai.admin_setup --force

# Depuis les sources
./install.sh --reset-password        # ou : make set-admin-password
```

Les autres cas de figure de la même commande :

| Situation | Commande |
|---|---|
| Mot de passe oublié (compte existant) | `admin_setup --force` |
| **Adresse** oubliée aussi | `admin_setup --force --email <nouvelle@adresse>` |
| Corriger l'adresse **sans** toucher au mot de passe (sessions préservées) | `admin_setup --email <a@b.fr> --email-only` |
| Savoir si un compte existe (script, supervision) | `admin_setup --check` — sort `0` si oui, `1` sinon |
| Créer le compte **sans passer par l'interface** (poste sans navigateur) | `admin_setup --email <a@b.fr>` |

Ce dernier cas est aussi la **parade au risque de revendication** si vous devez déployer sur un
réseau que vous ne maîtrisez pas : créez le compte en CLI juste après le `up -d`, avant même
d'ouvrir la console. `POST /api/auth/setup` répondra alors 409 à tout le monde.

> `--force` est **obligatoire** pour écraser un compte existant : sans lui, la commande refuse
> (« Un compte administrateur est déjà configuré »). Et il n'y a **aucun** moyen de passer le
> mot de passe par une variable d'environnement — il est lu sur `stdin` (pipe) ou saisi de
> façon masquée, précisément pour ne pas laisser de copie en clair dans `docker inspect`,
> l'historique du shell ou les logs de l'orchestrateur.

## 4. Vérifier

```bash
curl http://localhost:8000/health        # état complet : moteur + GLPI (+ LLM avec ?probe=true)
curl http://localhost:8000/health/live   # VIVACITÉ seule : processus + base, aucun appel sortant
```

`/health` est en **échec** si GLPI est injoignable (FR-27, FR-1) — pas de démarrage
silencieux dégradé. Il répond **503** si les secrets sont illisibles (master key
incohérente), avec un message qui nomme la cause.

> **`/health/live` est ce que sondent les conteneurs**, et c'est délibéré : `/health`
> ouvre une session GLPI à chaque appel — toutes les 30 s, cela fait environ 2 880
> sessions par jour dans les journaux du client — et un GLPI momentanément injoignable
> marquait `unhealthy` un moteur parfaitement sain (redémarrages en boucle sous Swarm,
> Kubernetes ou autoheal). `?probe=true` ajoute un appel **facturé** au fournisseur LLM et
> exige désormais une session administrateur : à réserver au diagnostic humain.

**Diagnostic GLPI dédié** (recommandé à l'install — valide auth, référentiels, lecture
des tickets, et optionnellement l'écriture d'un Suivi privé) — identifiants via
l'environnement, **jamais en dur** :

```bash
GLPI_BASE_URL="https://glpi.exemple.local/apirest.php" \
GLPI_USER_TOKEN="…" GLPI_APP_TOKEN="…" \
  make glpi-diagnose        # lecture seule
# test d'écriture d'un Suivi privé sur un ticket de test :
#   uv run python scripts/glpi_diagnose.py --write-test <ticket_id>
```

> ✅ Intégration validée sur GLPI 10/11 (apirest.php) : `initSession`, `ITILCategory`,
> `User`/`Profile`/`Profile_User`, `Group`, `Entity`, lecture des Tickets et écriture d'un
> `ITILFollowup` **privé** sans mutation de champ (mode suggestion).

## 5. HTTPS via reverse proxy (FR-26)

La terminaison **TLS est déléguée à un reverse proxy** (nginx, Caddy, …) placé devant le service sur le port `8000`. Le service ne sert pas TLS lui-même. Configurez le proxy pour **rediriger ou refuser le HTTP nu** et ne servir qu'en HTTPS.

> ⚠️ **IP réelle du client derrière le proxy** — par défaut, `request.client.host` vaut l'IP du proxy, ce qui rend le rate-limit du login (FR-24) contournable. Pour rétablir l'IP d'origine :
>
> 1. Activez `TRUST_PROXY_HEADERS=true` dans le `.env` (lecture de la 1ʳᵉ valeur de `X-Forwarded-For`).
> 2. Lancez `uvicorn` avec `--proxy-headers --forwarded-allow-ips=<IP du proxy>` (ou `*` si le proxy est seul devant). En conteneur, l'entrypoint le fait automatiquement quand `TRUST_PROXY_HEADERS=true` est exporté.
> 3. N'activez ces options **que** derrière un proxy fiable — sans ça, n'importe quel client peut forger l'IP via le header.

## 6. Réglages de durcissement & observabilité (durcissement audit 2026-05)

Tous **optionnels** dans le `.env` (valeurs par défaut sûres). Détails dans
[`docs/audit-2026-05.md`](audit-2026-05.md) et [`SECURITY.md`](../SECURITY.md).

| Variable | Défaut | Rôle |
|---|---|---|
| `DEV_OPEN_ADMIN` | `false` | **Fail-closed** : tant qu'aucun compte admin n'existe, l'admin est refusée (401). Mettre `true` rouvre l'admin **sans aucune authentification** — **dev/labo uniquement, jamais en prod**. ⚠️ Plus dangereux qu'avant : une instance neuve est désormais, normalement, sans compte. |
| `SESSION_HTTPS_ONLY` | `true` | Flag `Secure` du cookie de session. Défaut code `true` ; les artefacts livrés (`.env` de l'installeur, compose Portainer) posent `false` pour le pilote HTTP (sinon login impossible). Repasser à `true` derrière un TLS. |
| `SSRF_GUARD_ENABLED` | `true` | Garde anti-SSRF au runtime : résout chaque hôte sortant (LLM, GLPI) et **bloque les IP internes** avant l'appel. Ne désactiver qu'en réseau de confiance. |
| `LOG_LEVEL` | `INFO` | Seuil de log racine (`DEBUG`…`CRITICAL`). |
| `LOG_FORMAT` | `text` | `text` (dev) ou `json` (1 ligne = 1 objet JSON pour Loki/ELK ; **sans PII**). |
| `METRICS_ENABLED` | `true` | Active l'instrumentation + l'endpoint `GET /metrics`. `false` → endpoint absent. |
| `METRICS_TOKEN` | *(vide)* | Si défini, `/metrics` exige `Authorization: Bearer <jeton>` (ou `X-Metrics-Token`), sinon 401. Vide = scrape non authentifié (rétrocompatible). |

### Métriques Prometheus

Quand `METRICS_ENABLED=true` (défaut), le service expose **`GET /metrics`** (hors `/api`,
format Prometheus) : compteur de requêtes (`itsm_http_requests_total`) et histogramme de
latence par **route templatée** (pas de PII dans les labels). Exemple de scrape :

```yaml
# prometheus.yml
scrape_configs:
  - job_name: itsm-modern-ai
    static_configs: [{ targets: ["itsm:8000"] }]
    # si METRICS_TOKEN est défini :
    # authorization: { credentials: "<le jeton>" }
```

### Logging structuré

`LOG_FORMAT=json` produit un log **structuré** (une ligne = un objet JSON) directement
agrégeable (Loki/ELK). Aucune PII n'est émise (pas de corps de requête, pas de query string).

## Mise à jour

Pour une instance basée sur l'**image GHCR**, la mise à jour ne reconstruit rien — on tire la
nouvelle image et on redémarre :

```bash
docker compose pull && docker compose up -d
```

`pull` récupère aussi l'image `postgres:17-alpine` si un correctif mineur est sorti — c'est
voulu, la majeure reste figée (cf. [`docs/postgresql.md`](postgresql.md#7-la-majeure-17-est-épinglée--ne-la-bumpez-pas-à-la-légère)).

Les **migrations Alembic s'appliquent automatiquement** au démarrage (entrypoint), et les
**données sont préservées** : les volumes **`itsm_data`** (master key, sauvegardes) et
**`itsm_pgdata`** (les données) ne sont jamais touchés — **ne JAMAIS faire
`docker compose down -v`**, qui détruirait les deux. Le tag `:<sha>` permet d'**épingler** une
version et de revenir en arrière proprement.

> Pour une instance **depuis les sources** (build local), la mise à jour passe par
> `./install.sh` — voir la section « Depuis les sources / hors-ligne » ci-dessous.

## Sauvegarde

**La commande de référence est `python -m itsm_modern_ai.backup`** (voir « Sauvegarde et
restauration » plus haut) : elle prend un dump cohérent **et** la master key, et vérifie ce
qu'elle a écrit. Une archive du volume ne remplace pas ce dump — copier `data/postgres` d'un
serveur en marche produit un cluster incohérent.

En complément, il reste utile d'archiver le volume **`itsm_data`** (`/app/data`) : il porte la
**master key** et les sauvegardes déjà produites. Exemple :

```bash
docker run --rm -v itsm_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/itsm_data-$(date +%F).tar.gz -C /data .
```

> ⚠️ Sans la master key, **les secrets chiffrés sont irrécupérables** : tokens GLPI, clés
> LLM et **hash du mot de passe admin**. Depuis la 0.9.48, le moteur **refuse de démarrer**
> plutôt que de générer une nouvelle clé par-dessus des secrets existants — il vaut mieux
> un arrêt explicite qu'une instance qui démarre « verte » avec des secrets illisibles et
> un login qui répond « mot de passe incorrect ». Pour repartir de zéro en connaissance de
> cause : `ITSM_ALLOW_NEW_MASTER_KEY=true` (les secrets devront être re-saisis).
>
> Ce garde-fou vaut aussi quand **la base est injoignable** : le moteur réessaie, puis refuse
> de démarrer plutôt que de générer une clé « en attendant ». Une clé écrite dans ce cas
> existerait au démarrage suivant et court-circuiterait le contrôle — plus aucun boot
> n'avertirait, pour une instance verte mais définitivement cassée. Le remède est de réparer
> l'accès à la base (`docker compose logs postgres`, `DATABASE_URL`), pas de forcer la clé.

### Depuis les sources : `make backup`

Si vous disposez du dépôt, la cible dédiée écrit au même format, hors du volume :

```bash
make backup        # → backups/<horodatage>/{itsm.dump,master.key}
```

C'est un raccourci de développement : la logique vit dans le paquet
(`src/itsm_modern_ai/backup.py`), pour rester disponible en déploiement *pull-only*. Elle
exige `pg_dump` sur la machine qui la lance — présent dans l'image livrée, à installer sur un
poste de dev (Debian/Ubuntu : `apt install postgresql-client-17`, **même majeure** que le
serveur).

### Restauration et retour arrière

```bash
./install.sh --list-backups              # sauvegardes disponibles
./install.sh --rollback                  # la plus récente
./install.sh --rollback 20260808-201310  # une sauvegarde précise
```

Le retour arrière est **entièrement automatisé**, y compris la base — ce n'était pas le cas
avant. Dans l'ordre : il demande une **confirmation tapée** (voir ci-dessous), **arrête le seul
moteur** (la base doit rester en marche pour être restaurée), **dumpe l'état actuel** dans
`data/pre-rollback-<horodatage>` — un rollback raté reste donc réversible —, **remet le schéma
à plat**, restaure **ensemble** le dump et la master key (l'une sans l'autre est inutile),
remet le code ou l'image de l'époque, **préserve le port publié**, puis redémarre l'instance.

**La confirmation n'est pas une formalité.** Il faut **taper l'horodatage** de la sauvegarde
visée : `Entrée` ne vaut pas oui, `--yes` non plus, et l'absence de terminal encore moins — le
script s'arrête plutôt que d'inventer une réponse à une opération destructive. Pour restaurer
sans terminal (automatisation), déclarez-le explicitement :

```bash
ITSM_ROLLBACK_CONFIRME=20260808-201310 ./install.sh --rollback 20260808-201310
```

Et **si l'état courant ne peut pas être dumpé, le rollback est refusé** — pas « poursuivi avec
un avertissement ». Sans ce dump, la remise à plat du schéma serait un aller simple.

Trois détails qui comptent le jour J : le script sait encore lire les sauvegardes au format SQL
brut (`dump.sql`) produites par ses versions antérieures ; il restaure avec `--exit-on-error`,
donc s'arrête à la première erreur au lieu de laisser une base à moitié faite ; et il **remet le
schéma à plat** au lieu de compter sur `pg_restore --clean` (qui laisserait en place les tables
créées par des migrations postérieures à la sauvegarde, cf. § Sauvegarde et restauration).

Une sauvegarde est prise **automatiquement avant toute mise à jour** (`./install.sh --update`
ou le menu). Elle est **bloquante** : si le dump échoue, la mise à jour est interrompue et
rien n'a été modifié.

## Depuis les sources / hors-ligne (airgap, build local)

Cette voie **n'est plus le chemin grand public** (c'est l'image GHCR ci-dessus) mais reste
**pleinement valide** pour l'**airgap**, le **build local** et les bundles hors-ligne. Elle
**construit** l'image du moteur localement au lieu de la tirer.

> ⚠️ **En airgap, il y a deux images, pas une.** `install.sh --bundle` charge l'image du
> **moteur** ; l'image **`postgres:17-alpine`** doit être présente elle aussi, sans quoi
> `docker compose up` échoue faute de pouvoir la tirer. Transférez-la avec le reste :
> ```bash
> # sur une machine connectée
> docker pull postgres:17-alpine && docker save postgres:17-alpine | gzip > postgres17.tar.gz
> # sur la machine cible
> gunzip -c postgres17.tar.gz | docker load
> ```

### Installation rapide

```bash
git clone https://github.com/WicaebethTheo/itsm-modern-ai.git
cd itsm-modern-ai
./install.sh
```

Le script vérifie Docker, crée `.env`, génère la clé de chiffrement, **build + démarre**
(migrations incluses), attend que le moteur soit sain, puis affiche l'**URL de la console** et
vous renvoie vers l'**écran de création du compte** — il ne demande plus de mot de passe (le
moteur n'en lit plus dans l'environnement, et un prompt n'aurait pas d'adresse à proposer).
Ouvrez `http://<vm>:8000/` et créez votre compte : email + mot de passe, stocké **uniquement en
hash Argon2 chiffré** (jamais en clair).

⚠️ Comme pour les voies GHCR, l'instance est **revendicable** entre ce démarrage et cette
création — l'installeur vous le rappelle dans sa conclusion. Mot de passe oublié plus tard :
`./install.sh --reset-password` (cf. « Mot de passe administrateur oublié »).

### Équivalent manuel

```bash
cp .env.example .env
```

Le `.env` ne contient **que des réglages non-secrets**, la `MASTER_KEY` de chiffrement et les
identifiants de la base. Renseignez :

- **`MASTER_KEY`** — clé Fernet servant à chiffrer les secrets au repos (FR-25). Générez-la :

  ```bash
  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  ```

  Si elle est laissée vide, une clé est générée automatiquement et persistée dans `data/master.key`.

- **`POSTGRES_PASSWORD`** — mot de passe du rôle `itsm`, créé à l'**initialisation du cluster**.
  À changer **avant le tout premier démarrage** : ensuite il faudrait un `ALTER USER`.
- **`ITSM_DATABASE_URL`** — l'URL que le moteur utilise pour joindre le service `postgres`.
  Elle doit porter **le même** utilisateur, mot de passe et base que les trois `POSTGRES_*`,
  sinon le moteur ne se connecte plus. Un mot de passe contenant `@ : / ? # %` s'y écrit
  **encodé-URL** (`%40`, `%3A`, `%25`…).

> ⚠️ Écrire `DATABASE_URL=…` dans `.env` n'a **aucun effet sous compose** : le bloc
> `environment:` du service `itsm` a la priorité sur `env_file:` et pose sa propre valeur.
> `DATABASE_URL` ne sert qu'aux exécutions **depuis les sources** (`make run`, `make migrate`,
> `pytest`). La molette sous compose est `ITSM_DATABASE_URL`. Détail complet :
> [`docs/postgresql.md`](postgresql.md#4-variables-denvironnement).

> Les **secrets** (clé API LLM, tokens GLPI) ne se mettent **jamais** dans `.env` : ils se poussent au runtime via l'API (cf. §3).

Démarrer le service (build local) :

```bash
docker compose up -d --build
```

L'image est construite en **multi-stage** (build de la SPA React avec Node, puis moteur
Python qui la sert en statique).

### Mise à jour (build local)

Relancez l'installeur :

```bash
./install.sh
```

S'il détecte une instance existante, un menu propose **Mettre à jour / Réinstaller**. La mise à
jour **sauvegarde d'abord** la base (dump vérifié) et la master key, horodatés sous `backups/`,
récupère la nouvelle version (`git pull`), **reconstruit et redémarre**, puis attend que le
moteur soit sain. Le dump est pris **à chaud** : pas d'interruption de service pour la
sauvegarde, et une instance actuellement à l'arrêt reste sauvegardable — le script démarre la
base seule au besoin. Les **données sont préservées** (le dossier `./data`, qui porte le
cluster et la clé, n'est jamais touché — **ne JAMAIS faire `docker compose down -v`**).

- `./install.sh --update` : mise à jour directe, non-interactive (CI, scripts).
- **En cas d'échec** (build KO, migration KO), le script **relance automatiquement
  l'instance précédente** au lieu de la laisser à l'arrêt, et affiche la commande de
  retour arrière. Le rollback complet — base, master key, code/image, port publié — se
  fait en une commande : `./install.sh --rollback [horodatage]` (cf. section
  « Restauration et retour arrière »).

## Note — pilote, pas production

Passer à PostgreSQL lève une limite réelle (le mono-writer SQLite, la sauvegarde à chaud
incertaine) mais **ne fait pas de ce déploiement une architecture de production** : un seul
cluster, pas de réplication, pas de bascule automatique, pas de tuning, sauvegardes déclenchées
par l'exploitant, et un rate-limit de login toujours en mémoire (donc mono-process). C'est
**acceptable en pilote**. Un plan de durcissement est prévu avant tout déploiement payant
(cf. PRD §12).

Ce qui a changé dans le contrat d'exploitation, et qu'il vaut mieux savoir avant l'incident
plutôt qu'après : **deux services à superviser**, **un volume de plus** à sauvegarder, **~1 Gio
de RAM en plus**, et une **majeure PostgreSQL épinglée** qu'il faudra migrer un jour
(procédure : [`docs/postgresql.md`](postgresql.md#7-la-majeure-17-est-épinglée--ne-la-bumpez-pas-à-la-légère)).
En contrepartie, la restauration complète est désormais **automatisée** (`./install.sh
--rollback`) au lieu d'être une manipulation de fichiers.

> **Aucune migration SQLite → PostgreSQL n'est fournie**, et il n'y en aura pas : une instance
> SQLite antérieure repart à blanc et se reconfigure depuis la console. Détail de ce qui est
> perdu et de ce qui ne l'est pas : [`docs/postgresql.md`](postgresql.md#2-aucune-migration-sqlite--postgresql-nest-fournie).
</content>
</invoke>
