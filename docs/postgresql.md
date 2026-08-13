# PostgreSQL — la base du produit

> PostgreSQL est la seule base supportée. Le moteur ne démarre pas sans elle, et la stack
> livrée embarque le service `postgres` comme composant à part entière.

## 1. Ce que ça coûte, ce que ça apporte

Ce que la base coûte à l'exploitant :

- Deux services au lieu d'un. Il faut les démarrer, les superviser et les mettre à jour
  ensemble. Un `docker run` nu demande un réseau explicite et deux conteneurs
  (cf. [`install.md`](install.md#c-docker-run-durci-deux-conteneurs)).
- Un volume de plus. Le cluster PostgreSQL vit à part de la `master.key`. Une sauvegarde
  qui n'emporte que l'un des deux ne restaure rien d'exploitable.
- De la mémoire. La stack réserve 256 Mio à la base (contre 128 Mio au moteur) et la
  plafonne à 1 Gio (512 Mio pour le moteur) : comptez ~250 Mio de RAM en plus en régime
  normal, et dimensionnez à ~1,5 Gio pour que ni l'un ni l'autre ne touche son plafond.
  Le plafond de la base est le plus généreux parce que PostgreSQL alloue `shared_buffers`
  plus `work_mem` par connexion, et qu'une base tuée par l'OOM killer en pleine écriture
  est le pire des scénarios.
- Une majeure PostgreSQL à épingler, et à migrer un jour. La stack est figée sur la
  majeure 17 (supportée jusqu'en 2029). Le jour du passage à 18+, il faudra dumper,
  recréer le cluster et restaurer (§6) : une opération planifiée, pas un `pull`.
- Un mot de passe de base à gérer, cohérent entre trois variables (§3), et qu'on ne peut
  plus changer par un simple redémarrage une fois le cluster initialisé.

Ce qu'on obtient en échange :

- Un vrai serveur concurrent. Le poller, la console et le job de purge écrivent en
  parallèle sans se bloquer.
- Une sauvegarde à chaud cohérente. `pg_dump` travaille dans une transaction à snapshot
  isolé : l'archive reflète un instant unique, même sous écriture.
- Un typage strict. PostgreSQL rejette `0`/`1` pour un booléen, et un horodatage sans
  fuseau sur un `timestamptz` : les erreurs de type se voient en CI plutôt qu'en production.
- La base peut vivre ailleurs. Un SGBD géré par la DSI (sauvegardé, répliqué, supervisé
  par les équipes qui savent le faire) devient une option de déploiement (§5).

Ce que cela n'apporte pas, et qu'il ne faut pas laisser croire : la stack livrée n'est pas
un cluster de production. Pas de réplication, pas de bascule automatique, pas de tuning,
juste un conteneur PostgreSQL avec ses réglages par défaut. La haute disponibilité reste à
construire par l'exploitant, ou à déléguer à une base externe.

## 2. Comment la stack est câblée

| | Depuis les sources (`docker-compose.yml`) | Pull-only (`docker-compose.portainer.yml`) |
|---|---|---|
| Image base | `postgres:17-alpine` | `postgres:17-alpine` |
| Données du cluster | bind `./data/postgres` | volume nommé `itsm_pgdata` |
| `master.key` + sauvegardes | bind `./data` | volume nommé `itsm_data` |
| Port de la base | aucun `ports:` — joignable seulement depuis le réseau compose | idem |

La base n'est pas publiée sur l'hôte, délibérément : l'exposer offrirait un service
d'authentification de plus à un attaquant, alors que `docker compose exec postgres psql`
suffit à l'exploitation.

Le moteur dépend de la base en `condition: service_healthy`, et non `service_started` : un
conteneur PostgreSQL qui vient de démarrer n'accepte pas encore les connexions. En
complément, l'entrypoint du moteur attend la base de façon bornée avant de lancer les
migrations : `DB_WAIT_MAX_TRIES` tentatives (défaut 60) espacées de `DB_WAIT_DELAY`
secondes (défaut 2), soit ~2 minutes. Ce filet couvre ce que `depends_on` ne couvre pas :
`docker run`, Swarm/k8s, et une base externe qui redémarre pendant une maintenance. Passé
le plafond, le conteneur sort en erreur avec la dernière erreur de connexion affichée ; une
base durablement injoignable est une panne à diagnostiquer, pas quelque chose à attendre
en silence.

## 3. Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `POSTGRES_USER` | `itsm` | Rôle créé à l'initialisation du cluster |
| `POSTGRES_PASSWORD` | `itsm` (⚠️ à changer) | Mot de passe créé à l'initialisation du cluster |
| `POSTGRES_DB` | `itsm` | Base créée à l'initialisation du cluster |
| `ITSM_DATABASE_URL` | `postgresql+psycopg://itsm:itsm@postgres:5432/itsm` | La molette à tourner sous compose : les deux composes la posent dans `environment:` sous le nom `DATABASE_URL` |
| `DATABASE_URL` | `postgresql+psycopg://itsm:itsm@localhost:5432/itsm` | Lue directement par le moteur. Utile hors compose (`make run`, `make migrate`, `docker run`) |
| `DB_POOL_SIZE` | `5` | Connexions persistantes du pool (poller + console en parallèle) |
| `DB_MAX_OVERFLOW` | `10` | Connexions temporaires au-delà du pool |
| `DB_POOL_PRE_PING` | `true` | Teste la connexion avant de la prêter — sans lui, une coupure réseau laisse dans le pool des connexions mortes qui ne se révèlent qu'à la première requête d'un utilisateur |

Trois pièges, tous déjà payés au moins une fois :

- `environment:` écrase `env_file:`. Écrire `DATABASE_URL=…` dans `.env` n'a aucun effet
  sous compose : la valeur du bloc `environment:` gagne, silencieusement. Sous compose, la
  variable à définir est `ITSM_DATABASE_URL`.
- Les trois `POSTGRES_*` ne servent qu'au tout premier démarrage, sur un cluster vide. Les
  changer ensuite ne fait rien : il faut un `ALTER USER itsm PASSWORD '…'` dans la base.
  Elles doivent aussi rester cohérentes avec `ITSM_DATABASE_URL`, sinon le moteur ne se
  connecte plus à sa propre base.
- Un mot de passe contenant `@ : / ? # %` doit être encodé-URL dans `ITSM_DATABASE_URL`
  (`%40`, `%3A`, `%25`…), sinon l'URL est mal découpée.

## 4. Migrations

Alembic est la source de vérité du schéma, et l'entrypoint joue `alembic upgrade head` à
chaque démarrage : une mise à jour d'image applique ses migrations toute seule.

```bash
# depuis les sources
make migrate                        # = alembic upgrade head
uv run alembic current              # doit afficher : a9c17f4b3e60 (head)
uv run alembic heads                # la tête attendue, sans se connecter à la base

# sur une instance conteneurisée
docker compose exec itsm alembic current
```

La CI éprouve les trois chemins réels sur un PostgreSQL réel : `upgrade head` sur base
vide, `upgrade head` sur base peuplée (le cas d'une mise à jour, là où un `add_column`
NOT NULL sans `server_default` explose), et l'aller-retour `downgrade -1` / `upgrade head`
qu'emprunte `install.sh --rollback`.

## 5. Base externe (SGBD géré par la DSI)

Rien n'oblige à utiliser le conteneur livré. Pointez `ITSM_DATABASE_URL` (ou `DATABASE_URL`
hors compose) sur votre serveur ; les paramètres de l'URL, `?sslmode=require` compris, sont
conservés jusque dans les outils de sauvegarde :

```bash
ITSM_DATABASE_URL=postgresql+psycopg://itsm:motdepasse@pg.interne.local:5432/itsm?sslmode=require
```

Deux points à ne pas manquer :

- Retirez le service `postgres` du compose, ainsi que le bloc `depends_on` qui le vise,
  sinon la stack démarre un second cluster, inutile et jamais lu.
- La majeure du serveur doit rester 17, comme le client embarqué dans l'image (§6) : c'est
  lui qui produit les sauvegardes.

## 6. La majeure 17 est épinglée

Le tag `postgres:17-alpine` continue de recevoir les correctifs mineurs et de sécurité :
laisser la majeure figée ne revient pas à rester sans correctifs. Passer à 18+ n'est en
revanche pas un bump d'image, pour trois raisons :

1. Format des données. Les fichiers d'un cluster 17 sont illisibles par une majeure
   supérieure : le conteneur refuse de démarrer (« database files are incompatible with
   server ») et boucle en restart.
2. Le client de l'image moteur doit suivre. L'image embarque `postgresql-client-17`, celui
   qui produit les sauvegardes. Un client d'une autre majeure fabrique des archives que le
   couple restaurant ne sait pas relire, ce qu'on ne découvre que le jour de la
   restauration. L'égalité des deux majeures est un contrat testé
   (`tests/unit/test_deployment_files.py`).
3. Piège propre à 18+. L'image officielle a déplacé son `PGDATA` de
   `/var/lib/postgresql/data` vers `/var/lib/postgresql/<majeure>/docker`. Le montage actuel
   deviendrait hors-sujet : PostgreSQL initialiserait un cluster vide dans la couche
   écrivable du conteneur, le moteur démarrerait sur une base vide sans la moindre erreur,
   et tout serait perdu au prochain `up -d`. Un bump vers 18+ impose donc aussi de changer
   la cible du montage en `/var/lib/postgresql`.

Procédure de bump, moteur à l'arrêt (jamais `down -v`) :

```bash
docker compose stop itsm
docker compose exec -T postgres pg_dump -U itsm -Fc itsm > avant-bump.dump
docker compose down                          # SANS -v
mv data/postgres data/postgres.pg17.bak      # on garde l'ancien cluster
#  … changer le tag dans docker-compose.yml ET la majeure du client dans le Dockerfile …
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U itsm -d itsm --no-owner < avant-bump.dump
docker compose up -d itsm
```

(`pg_upgrade` est l'alternative, mais exige les binaires des deux majeures dans la même
image, que l'image officielle ne fournit pas.)

Un garde-fou refuse le démarrage plutôt que de laisser boucler la stack. `install.sh` lit
`data/postgres/PG_VERSION` (la majeure inscrite par `initdb`) et la compare à celle du
compose avant tout `docker compose up` : si elles diffèrent, il s'arrête en affichant la
procédure ci-dessus, sans rien modifier. `docker/entrypoint.sh` fait la même lecture en
repli, pour les topologies où le moteur démarre sans attendre la base. Un `FATAL: database
files are incompatible with server` répété toutes les deux secondes n'est pas un
diagnostic exploitable. Si un `data/postgres` résiduel traîne alors que la vraie base est
ailleurs (SGBD externe, §5), le repli de l'entrypoint se neutralise avec
`ITSM_IGNORER_MAJEURE_PGDATA=true`.

## 7. Sauvegarde et restauration

Elles reposent entièrement sur `pg_dump` / `pg_restore` et sont décrites une seule fois,
dans [`install.md`](install.md#sauvegarde-et-restauration). Trois rappels qui coûtent cher
à apprendre autrement :

- Ne copiez jamais `data/postgres` d'un serveur en marche. Fichiers de données et WAL sont
  capturés à des instants différents : la copie paraît réussir et se révèle irrécupérable.
- La `master.key` fait partie de la sauvegarde. Sans elle, la base restaurée est
  définitivement illisible : mot de passe admin, tokens GLPI et clé LLM sont chiffrés avec.
- Remettez le schéma à plat avant de restaurer (`DROP SCHEMA public CASCADE; CREATE SCHEMA
  public;`), plutôt que de compter sur `pg_restore --clean`. `--clean` ne supprime que les
  objets présents dans l'archive : une table créée par une migration postérieure à la
  sauvegarde survit, alors qu'`alembic_version` est rembobiné. La restauration paraît
  réussir, et c'est la mise à jour suivante qui meurt sur `relation "..." already exists`.
  `./install.sh --rollback` fait déjà cette remise à plat, après avoir dumpé l'état courant.

## 8. Tests

Toute la suite tourne sur un PostgreSQL réel, avec un schéma jetable par test, en local
comme en CI. Comment en lancer un et le viser :
[`docs/testing.md`](testing.md#prérequis--un-postgresql-joignable).

## Voir aussi

- [`docs/install.md`](install.md) — déploiement, sauvegarde, restauration, retour arrière.
- [`docs/architecture.md`](architecture.md) · [`docs/testing.md`](testing.md)
