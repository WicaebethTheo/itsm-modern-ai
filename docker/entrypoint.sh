#!/usr/bin/env bash
# Applique les migrations (Alembic = source de vérité) puis démarre le moteur.
set -euo pipefail

# Durcissement : si on démarre en root (cas par défaut), on s'assure que le volume
# monté ./data appartient à l'utilisateur non-root `app` (il peut être root sur un
# déploiement existant), puis on RELANCE ce script en `app` via gosu. Au second
# passage (id != 0), on saute ce bloc et on exécute le moteur sans privilèges.
# Chown CIBLÉ, plus de `chown -R /app/data` global : le -R re-parcourait TOUTE la
# base à chaque boot et, surtout, écrasait l'ownership de data/postgres/.
# L'exclusion `! -name postgres` est CONSERVÉE, et elle compte désormais PLUS qu'avant :
# docker-compose.yml monte le PGDATA en bind sur ./data/postgres (topologie inchangée),
# et ce dossier n'est plus celui d'un profile optionnel — il existe sur TOUTE installation
# depuis les sources. Or il appartient à l'uid du conteneur postgres, et PostgreSQL REFUSE
# de démarrer si son PGDATA ne lui appartient pas (« data directory has invalid
# ownership ») : un chown -R par l'app mettrait la base entière en crash-loop.
# (La voie Portainer, elle, utilise un volume nommé dédié : rien à exclure de ce côté.)
# ── Garde de MAJEURE PostgreSQL (repli) ──────────────────────────────────────
# Les fichiers d'un cluster ne sont PAS relisibles par une autre majeure. Quand le PGDATA
# est visible depuis ce conteneur (topologie compose : ./data monté en entier, la base vit
# dans ./data/postgres), on lit PG_VERSION et on refuse de continuer si la majeure diffère
# de celle du client `pg_dump` embarqué — les deux bougent ENSEMBLE, c'est un contrat testé
# (tests/unit/test_deployment_files.py), donc ce client est une référence fiable.
#
# ⚠️ C'est un REPLI, pas la protection principale : sous compose, `depends_on:
# service_healthy` empêche ce conteneur de démarrer tant que la base boucle, donc ce code
# ne s'exécute même pas. La vraie garde est dans install.sh, AVANT le `up -d`. Ce repli
# couvre les topologies sans `depends_on` (docker run, orchestrateur ad hoc) où le moteur
# démarre pendant que la base refuse de naître : il transforme 120 s d'attente suivies d'un
# « base injoignable » en un diagnostic exact.
#
# Lu AVANT le passage en `app` : PGDATA est en 0700 et appartient à l'utilisateur postgres,
# seul root peut le lire. Échappatoire si un ./data/postgres résiduel traîne alors que la
# base réelle est ailleurs (SGBD externe) : ITSM_IGNORER_MAJEURE_PGDATA=true.
verifier_majeure_pgdata() {
  local fichier=/app/data/postgres/PG_VERSION presente attendue
  [ "${ITSM_IGNORER_MAJEURE_PGDATA:-false}" = "true" ] && return 0
  [ -r "$fichier" ] || return 0                      # PGDATA invisible d'ici : rien à dire
  presente="$(tr -dc '0-9.' < "$fichier" | cut -d. -f1)"
  # `pg_dump (PostgreSQL) 17.10 (Debian …)` → 17
  attendue="$(pg_dump --version 2>/dev/null | sed -n 's/.*PostgreSQL) \([0-9]\{1,2\}\).*/\1/p')"
  [ -n "$presente" ] && [ -n "$attendue" ] || return 0
  [ "$presente" = "$attendue" ] && return 0
  echo "[entrypoint] ÉCHEC : le cluster de ./data/postgres a été initialisé par PostgreSQL" >&2
  echo "[entrypoint]   $presente, alors que cette version attend PostgreSQL $attendue." >&2
  echo "[entrypoint]   Les fichiers d'un cluster ne se relisent pas d'une majeure à l'autre :" >&2
  echo "[entrypoint]   PostgreSQL refusera de démarrer (« database files are incompatible" >&2
  echo "[entrypoint]   with server ») et bouclera en redémarrage." >&2
  echo "[entrypoint]   Migration, moteur arrêté : dumper avec l'image d'origine" >&2
  echo "[entrypoint]     (postgres:$presente-alpine) via pg_dump -Fc, METTRE DE CÔTÉ" >&2
  echo "[entrypoint]     data/postgres (mv, jamais rm), laisser le nouveau cluster naître," >&2
  echo "[entrypoint]     puis pg_restore --no-owner. Détail : ./install.sh --rollback -h," >&2
  echo "[entrypoint]     docs/postgresql.md § montée de majeure." >&2
  echo "[entrypoint]   Repli immédiat : remettre postgres:$presente-alpine dans le compose." >&2
  exit 1
}

if [ "$(id -u)" = "0" ]; then
  verifier_majeure_pgdata
  mkdir -p /app/data
  APP_UID="$(id -u app)"
  [ "$(stat -c %u /app/data)" = "$APP_UID" ] || chown app:app /app/data
  find /app/data -mindepth 1 -maxdepth 1 ! -name postgres | while IFS= read -r child; do
    [ "$(stat -c %u "$child")" = "$APP_UID" ] || chown -R app:app "$child"
  done
  echo "[entrypoint] passage en utilisateur non-root « app »"
  exec gosu app "$0" "$@"
fi

# Attente BORNÉE de PostgreSQL. `depends_on: service_healthy` couvre le cas compose, mais
# pas `docker run`, pas Swarm/k8s, et pas une base externe (SGBD géré par la DSI) qui
# redémarre pendant une maintenance. Sans cette attente, `alembic upgrade head` échoue à la
# première seconde, `set -e` tue le conteneur, et le restart-loop donne un « ça ne démarre
# pas » illisible alors que la base arrivait 3 s plus tard.
# Bornée VOLONTAIREMENT (pas de boucle infinie muette) : au bout du plafond on sort en
# erreur avec un message exploitable — une base durablement injoignable est une panne à
# diagnostiquer, pas quelque chose à attendre en silence.
# Hôte visé par DATABASE_URL, lu depuis l'URL RÉELLE du moteur (pas une reconstruction).
hote_de_la_base() {
  python -c "
from sqlalchemy import make_url
from itsm_modern_ai.config.settings import get_settings
print(make_url(get_settings().database_url).host or '')
" 2>/dev/null || echo ""
}

# Conseil affiché QUAND l'hôte visé est la boucle locale.
#
# Le défaut du code est `...@localhost:5432` — pensé pour un `make run` depuis les sources.
# Dans un conteneur, `localhost` désigne le conteneur LUI-MÊME, qui n'embarque aucun
# PostgreSQL : un `docker run` sans `DATABASE_URL` ne peut donc pas aboutir. Sans ce
# message, l'exploitant attendait le plafond entier — deux minutes — pour lire ensuite
# « vérifiez le service postgres (docker compose logs postgres) », c'est-à-dire un conseil
# qui ne s'applique PAS au chemin qu'il a pris.
#
# On n'échoue pas pour autant : avec `--network host`, `localhost` désigne l'hôte, et un
# PostgreSQL peut très bien y écouter — la configuration est alors parfaitement valable,
# elle a juste besoin qu'on la laisse démarrer.
conseil_si_base_locale() {
  case "$1" in
    localhost|127.0.0.1|::1|"") ;;
    *) return 0 ;;
  esac
  echo "[entrypoint] DATABASE_URL vise « $1 » : dans un conteneur, c'est CE conteneur," >&2
  echo "[entrypoint]   et l'image n'embarque aucun PostgreSQL. Trois façons d'en fournir un :" >&2
  echo "[entrypoint]   · docker compose (recommandé) — le compose du README lève la base ;" >&2
  echo "[entrypoint]   · docker run --network <reseau> -e DATABASE_URL=postgresql+psycopg://" >&2
  echo "[entrypoint]     <user>:<mdp>@<hote>:5432/<base> — pointez le conteneur PostgreSQL ;" >&2
  echo "[entrypoint]   · une base gérée par la DSI : même variable, son hôte à elle." >&2
  echo "[entrypoint]   (Si vous utilisez --network host avec un PostgreSQL sur la machine," >&2
  echo "[entrypoint]    ignorez ceci : l'attente ci-dessous fera son travail.)" >&2
}

DB_DERNIERE_ERREUR=""
attendre_la_base() {
  local plafond="${DB_WAIT_MAX_TRIES:-60}" delai="${DB_WAIT_DELAY:-2}" essai=1
  while [ "$essai" -le "$plafond" ]; do
    # On teste avec l'URL RÉELLE du moteur (Settings), pas une reconstruction approximative :
    # une base externe, un port ou un `?sslmode=` particuliers sont ainsi couverts.
    # L'erreur est CONSERVÉE (et non jetée) : au bout du plafond, on la montre. Un mot de
    # passe faux et une base pas encore levée donnent la même attente — pas le même message.
    if DB_DERNIERE_ERREUR="$(python -c "
from sqlalchemy import create_engine
from itsm_modern_ai.config.settings import get_settings
create_engine(get_settings().database_url).connect().close()
" 2>&1)"; then
      if [ "$essai" -gt 1 ]; then
        echo "[entrypoint] base PostgreSQL prête (tentative $essai)"
      fi
      return 0
    fi
    echo "[entrypoint] base PostgreSQL injoignable — tentative $essai/$plafond, nouvel essai dans ${delai}s"
    # Le conseil sort à la PREMIÈRE tentative ratée, pas au bout du plafond : deux secondes
    # au lieu de deux minutes pour savoir qu'on cherche une base là où il n'y en a pas.
    [ "$essai" -eq 1 ] && conseil_si_base_locale "$(hote_de_la_base)"
    essai=$((essai + 1))
    sleep "$delai"
  done
  return 1
}

if ! attendre_la_base; then
  echo "[entrypoint] ÉCHEC : PostgreSQL est resté injoignable." >&2
  # Les DEUX chemins, pas seulement compose : ce message s'adressait au seul déploiement
  # qui, précisément, n'en a presque jamais besoin.
  echo "[entrypoint]   · sous compose : docker compose logs postgres" >&2
  echo "[entrypoint]   · sinon : vérifiez DATABASE_URL (hôte, port, identifiants, réseau)." >&2
  echo "[entrypoint] Dernière erreur : $(echo "$DB_DERNIERE_ERREUR" | tail -3)" >&2
  exit 1
fi

echo "[entrypoint] alembic upgrade head"
alembic upgrade head

# ⚠️ PLUS AUCUN AMORÇAGE ADMIN ICI — et ce n'est pas un oubli.
# Le compte administrateur se crée désormais à la PREMIÈRE VISITE de l'interface
# (POST /api/auth/setup) : email + mot de passe saisis par l'exploitant, session ouverte
# dans la foulée. Le moteur ne lit plus AUCUN mot de passe dans l'environnement — ni
# `Settings.admin_password` (supprimé), ni la CLI `admin_setup` (qui ne lit plus que stdin
# ou une saisie masquée). Un bloc d'amorçage ici ne pourrait donc plus rien faire, sinon
# faire croire qu'il fait quelque chose.
# La contrepartie ASSUMÉE — l'instance est revendiquable par le premier arrivant tant que
# le compte n'existe pas — est annoncée BRUYAMMENT à chaque démarrage par
# `security.warn_if_setup_required` (appelé par le lifespan de api/app.py) : c'est ce
# WARNING qui remplace ce bloc, et lui seul.
# Récupération d'un mot de passe oublié (seul chemin) :
#   docker compose exec itsm python -m itsm_modern_ai.admin_setup --force

# Reverse proxy : si TRUST_PROXY_HEADERS=true, on active la lecture de XFF côté
# uvicorn (cf. https://docs.itsm-modern-ai.com/production-deployment/). `--forwarded-allow-ips=*` car le moteur n'est
# joignable que via le proxy en pilote conteneurisé.
if [ "${TRUST_PROXY_HEADERS:-false}" = "true" ]; then
  PROXY_ARGS="--proxy-headers --forwarded-allow-ips=*"
else
  PROXY_ARGS=""
fi

echo "[entrypoint] démarrage uvicorn"
exec uvicorn itsm_modern_ai.main:app --host 0.0.0.0 --port 8000 $PROXY_ARGS
