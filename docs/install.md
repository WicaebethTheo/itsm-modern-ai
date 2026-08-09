# Installation on-premise (pilote V1)

> Déploiement **pilote** : un seul conteneur Docker, base **SQLite**, **pas de haute disponibilité**.
> Ce n'est **pas** l'architecture de production. Voir la note « durcissement » en fin de page.

## Prérequis

- Une **VM Linux** avec **Docker** et **docker compose** (plugin v2).
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
| `X.Y.Z` / `X.Y` | version figée (ex. `0.9.54`, `0.9`) | qui veut épingler une version |
| `edge` | pointe de `main`, **entre deux releases** | tests, avant-première — jamais en production |
| `sha-<court>` | un commit précis de `main` | reproduction d'un incident |

`latest` ne bouge **que** sur une release publiée : un simple merge dans `main` ne modifie
rien pour un exploitant. Une mise à jour reste donc un acte volontaire de votre côté
(`docker compose pull && docker compose up -d`).

## Installation (image GHCR, recommandé)

Trois voies, toutes **sans clone ni build**. L'**admin est amorcé au premier démarrage** à partir
de la variable **`ITSM_ADMIN_PASSWORD`** (≥ 8 caractères) : l'amorçage est **idempotent** (un mot
de passe existant n'est **jamais** écrasé) et la variable peut être **retirée** après le 1er boot
(le hash est persisté chiffré dans le volume). **Sans** mot de passe, la console est **fail-closed**
(verrouillée, admin en 401).

### (a) One-liner (le plus simple)

```bash
curl -fsSL https://itsm-modern-ai.com/install | bash
```

Le script écrit un `docker-compose.yml` + un `.env` (avec un `ITSM_ADMIN_PASSWORD` généré ou
demandé), tire l'image GHCR et fait `docker compose up -d`. Puis ouvrez `http://<vm>:8000/`.

### (b) Portainer / orchestrateur

Collez le contenu de **`docker-compose.portainer.yml`** dans un nouveau *stack* Portainer (ou votre
orchestrateur), définissez **`ITSM_ADMIN_PASSWORD`** (≥ 8 caractères) dans les variables
d'environnement du stack, puis déployez. L'image est **tirée** depuis GHCR (aucun build).

Le stack utilise `${ITSM_IMAGE_TAG:-latest}`. Pour **épingler une version** — recommandé en
production, afin qu'un redéploiement ne tire pas silencieusement une version plus récente —
définissez `ITSM_IMAGE_TAG=0.9.48` dans les variables du stack. Sans cette variable, le
comportement reste `latest`.

### (c) `docker run` durci

```bash
docker volume create itsm_data
docker run -d --name itsm-modern-ai \
  -p 8000:8000 \
  -e ITSM_ADMIN_PASSWORD='change-me-min-8-chars' \
  -e SESSION_HTTPS_ONLY=false \
  -v itsm_data:/app/data \
  --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp \
  ghcr.io/wicaebeththeo/itsm-modern-ai:latest
```

> `SESSION_HTTPS_ONLY=false` est nécessaire pour se connecter en HTTP nu (défaut code `true`
> → cookie `Secure` ignoré, login impossible). Repasser à `true` derrière un TLS.

La **base SQLite** et la **master key** vivent dans le **volume nommé `itsm_data`**
(`/app/data` dans le conteneur) ; la `master.key` Fernet est **générée automatiquement au premier
démarrage**. Le service écoute sur le port **8000**.

## 3. Tout configurer dans l'interface web

Ouvrez l'**interface** sur **`http://<vm>:8000/`** (derrière le reverse proxy HTTPS en prod).
Connectez-vous avec le **mot de passe administrateur** amorcé au premier démarrage (variable
`ITSM_ADMIN_PASSWORD`). Toute la configuration se fait ici — **aucun fichier à éditer** :

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
| `DEV_OPEN_ADMIN` | `false` | **Fail-closed** : sans mot de passe admin, l'admin est refusée (401). Mettre `true` rouvre l'admin **sans** mot de passe — **dev/labo uniquement, jamais en prod**. |
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

Les **migrations Alembic s'appliquent automatiquement** au démarrage (entrypoint), et les
**données sont préservées** : le volume **`itsm_data`** (base + master key) n'est jamais touché —
**ne JAMAIS faire `docker compose down -v`**. Le tag `:<sha>` permet d'**épingler** une version et
de revenir en arrière proprement.

> Pour une instance **depuis les sources** (build local), la mise à jour passe par
> `./install.sh` — voir la section « Depuis les sources / hors-ligne » ci-dessous.

## Sauvegarde

Sauvegardez régulièrement le volume **`itsm_data`** (`/app/data`) : il contient à la fois la
**base SQLite** (`itsm.db`) **et** la **master key** (`master.key`). Exemple :

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

### Depuis les sources : `make backup`

Si vous disposez du dépôt, préférez la cible dédiée — elle produit une sauvegarde
**cohérente** :

```bash
make backup        # → backups/<horodatage>/{itsm.db,master.key}
```

> ⚠️ **Ne copiez jamais `itsm.db` seul à chaud.** La base est en mode **WAL** : les
> écritures récentes vivent dans `itsm.db-wal`, et un `cp` du seul `.db` peut produire un
> fichier **vide ou corrompu**, sans le moindre message d'erreur. `make backup` utilise
> `VACUUM INTO`, cohérent en ligne, et vérifie le résultat (`PRAGMA integrity_check`,
> nombre de tables et de lignes affichés). Un échec est **bruyant** et le dossier
> incomplet est supprimé.

### Restauration et retour arrière

```bash
./install.sh --list-backups              # sauvegardes disponibles
./install.sh --rollback                  # la plus récente
./install.sh --rollback 20260808-201310  # une sauvegarde précise
```

Le rollback restaure **ensemble** la base et la master key (l'une sans l'autre est
inutile), écarte les fichiers `-wal`/`-shm` périmés — les laisser corromprait la base
restaurée — remet le code ou l'image de l'époque, et **préserve le port publié**. L'état
courant n'est pas écrasé : il est déplacé dans `data/pre-rollback-<horodatage>`.

> PostgreSQL : la restauration n'est **pas** automatisée (opération destructive). Le
> script restaure la clé, le code et l'image, et **affiche** les commandes `psql` à
> exécuter pour le dump.

## Depuis les sources / hors-ligne (airgap, build local)

Cette voie **n'est plus le chemin grand public** (c'est l'image GHCR ci-dessus) mais reste
**pleinement valide** pour l'**airgap**, le **build local** et les bundles hors-ligne. Elle
**construit** l'image localement au lieu de la tirer.

### Installation rapide

```bash
git clone https://github.com/WicaebethTheo/itsm-modern-ai.git
cd itsm-modern-ai
./install.sh
```

Le script vérifie Docker, crée `.env`, génère la clé de chiffrement, **build + démarre**
(migrations incluses), attend que le moteur soit sain, puis **demande un mot de passe
administrateur** (saisie masquée + confirmation). Ce mot de passe est stocké **uniquement
en hash Argon2 chiffré** (jamais en clair). Pour le changer ensuite :
`./install.sh --reset-password`. Puis ouvrez `http://<vm>:8000/`.

### Équivalent manuel

```bash
cp .env.example .env
```

Le `.env` ne contient **que des réglages non-secrets**, la `MASTER_KEY` de chiffrement et l'URL de base de données. Renseignez :

- **`MASTER_KEY`** — clé Fernet servant à chiffrer les secrets au repos (FR-25). Générez-la :

  ```bash
  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  ```

  Si elle est laissée vide, une clé est générée automatiquement et persistée dans `data/master.key`.

- **`DATABASE_URL`** — par défaut `sqlite:///./data/itsm.db` (la base vit dans le volume monté).

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
jour **sauvegarde d'abord** `./data` (base + master key, horodaté sous `backups/`), récupère la
nouvelle version (`git pull`), **reconstruit et redémarre**, puis attend que le moteur soit sain.
Les **données sont préservées** (le volume de données n'est jamais touché — **ne JAMAIS faire
`docker compose down -v`**).

- `./install.sh --update` : mise à jour directe, non-interactive (CI, scripts).
- **En cas d'échec** (build KO, migration KO), le script **relance automatiquement
  l'instance précédente** au lieu de la laisser à l'arrêt, et affiche la commande de
  retour arrière. Le rollback complet — base, master key, code/image, port publié — se
  fait en une commande : `./install.sh --rollback [horodatage]` (cf. section
  « Restauration et retour arrière »).

## Note — pilote, pas production

Ce déploiement (SQLite, conteneur unique, pas de HA) est **acceptable en pilote** mais n'est **pas** l'architecture de production. Un plan de durcissement est prévu avant tout déploiement payant (cf. PRD §12).
</content>
</invoke>
