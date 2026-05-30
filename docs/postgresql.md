# Portage PostgreSQL — **Beta**

> ⚠️ **Beta — encore tout jeune.** SQLite reste le **défaut** et le mode éprouvé du pilote.
> Le support PostgreSQL est fonctionnel (mêmes migrations Alembic, code déjà
> *Postgres-ready*) mais n'a pas encore le vécu production de SQLite : à valider sur ton
> environnement avant bascule définitive (backups, HA, monitoring).

## Pourquoi Postgres

SQLite (mono-fichier, mono-process) convient au pilote. Pour la **prod multi-utilisateurs**
/ la **haute dispo** / les **backups en ligne**, PostgreSQL est le palier suivant. Le code
est déjà compatible : toutes les colonnes temporelles sont **timezone-aware** via le
`TypeDecorator UtcDateTime`, et les migrations utilisent `batch_alter_table` (compatibles
SQLite **et** Postgres) — aucun SQL spécifique SQLite.

## 1. Installer le driver

Le driver Postgres est un **extra** optionnel (n'alourdit pas l'install SQLite par défaut) :

```bash
uv sync --extra postgres      # ajoute psycopg[binary]
# ou : pip install "itsm-modern-ai[postgres]"
```

## 2. Configurer `DATABASE_URL`

```bash
# .env
DATABASE_URL=postgresql+psycopg://itsm:<password>@localhost:5432/itsm
```

- Schéma `postgresql+psycopg://` → driver **psycopg 3** (recommandé).
- Le pooling est activé automatiquement pour toute base **non-SQLite**
  (`pool_pre_ping=true`, `pool_size`/`max_overflow` réglables, cf. §5).

## 3. Appliquer les migrations

Les mêmes migrations Alembic tournent sur Postgres :

```bash
make migrate            # = alembic upgrade head
# vérifier :
alembic current        # doit afficher la tête (d2f8a9c5 …)
```

## 4. Avec Docker Compose

Un service `postgres` **optionnel** est fourni via un *profile* (n'est PAS lancé par
défaut, pour ne pas changer le comportement SQLite existant) :

```bash
# Lancer l'app AVEC Postgres :
docker compose --profile postgres up -d --build
```

Le service `itsm` lit alors `DATABASE_URL` pointant sur le conteneur `postgres`
(réseau interne compose), volume dédié `./data/postgres` pour la persistance.
Sans le profile, l'app démarre en **SQLite** comme avant.

## 5. Réglages de pool (optionnels)

| Variable | Défaut | Rôle |
|---|---|---|
| `DB_POOL_SIZE` | `5` | connexions persistantes du pool |
| `DB_MAX_OVERFLOW` | `10` | connexions temporaires au-delà du pool |
| `DB_POOL_PRE_PING` | `true` | teste la connexion avant usage (anti-coupure) |

Ces réglages sont **ignorés en SQLite** (pas de pool réseau).

## 6. Migration des données SQLite → Postgres

Le pilote démarre généralement « à blanc » sur Postgres (la config GLPI/LLM se re-pousse
via l'UI). Si tu veux **transférer** les données existantes (Journal, appels LLM, cache
référentiel) :

1. `alembic upgrade head` sur la base Postgres vide (crée le schéma).
2. Copier les tables avec un outil ETL respectant les types (ex. `pgloader`, ou un export
   CSV par table puis `COPY`). ⚠️ La `master.key` Fernet doit rester la **même** (sinon les
   secrets chiffrés deviennent illisibles) — elle vit dans `./data/master.key`, pas en base.
3. Vérifier `alembic current` et un `GET /health` après bascule.

> Un script de migration assisté pourra être ajouté ultérieurement (hors périmètre Beta).

## 7. Limites connues (Beta)

- Pas encore de tests CI dédiés Postgres (la CI tourne en SQLite) ; les migrations sont
  vérifiées manuellement sur Postgres.
- Pas de pooling avancé / réplication documentés (laissés à l'exploitant).
- Le portage **n'enlève pas** les autres prérequis prod (backups automatisés, alerting) —
  cf. [`docs/roadmap.md`](roadmap.md).

## Voir aussi
- [`docs/architecture.md`](architecture.md) · [`docs/testing.md`](testing.md) (`UtcDateTime`)
