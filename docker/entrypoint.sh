#!/usr/bin/env bash
# Applique les migrations (Alembic = source de vérité) puis démarre le moteur.
set -euo pipefail

# Durcissement : si on démarre en root (cas par défaut), on s'assure que le volume
# monté ./data appartient à l'utilisateur non-root `app` (il peut être root sur un
# déploiement existant), puis on RELANCE ce script en `app` via gosu. Au second
# passage (id != 0), on saute ce bloc et on exécute le moteur sans privilèges.
# Chown CIBLÉ, plus de `chown -R /app/data` global : le -R re-parcourait TOUTE la
# base à chaque boot et, surtout, écrasait l'ownership de data/postgres/ (PGDATA du
# profile compose `postgres`, possédé par l'uid du conteneur postgres — pas `app`).
# On ne touche donc que /app/data lui-même + ses enfants HORS postgres/, et
# uniquement si l'owner n'est pas déjà `app` (boots suivants = zéro chown).
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  APP_UID="$(id -u app)"
  [ "$(stat -c %u /app/data)" = "$APP_UID" ] || chown app:app /app/data
  find /app/data -mindepth 1 -maxdepth 1 ! -name postgres | while IFS= read -r child; do
    [ "$(stat -c %u "$child")" = "$APP_UID" ] || chown -R app:app "$child"
  done
  echo "[entrypoint] passage en utilisateur non-root « app »"
  exec gosu app "$0" "$@"
fi

echo "[entrypoint] alembic upgrade head"
alembic upgrade head

# Amorçage admin (déploiement orchestrateur : Portainer / docker run / compose).
# Sans install.sh, rien n'amorce le compte admin → la console démarre verrouillée
# (security.py est fail-closed : pas de hash = accès admin refusé). On accepte
# ITSM_ADMIN_PASSWORD OU son alias ADMIN_PASSWORD (que security.py amorce aussi en
# lazy) ; ici on le fait tôt, au boot, avec un log clair. Propriétés :
#   - idempotent : on saute si `--check` confirme un admin déjà configuré ;
#   - jamais --force : on n'écrase JAMAIS un mot de passe existant au boot ;
#   - best-effort : on ne fait JAMAIS échouer le démarrage là-dessus (le `if`
#     neutralise le `set -e`, et le mot de passe peut être (re)défini dans l'UI).
# On tourne déjà en user non-root `app` ici (gosu plus haut), cohérent avec le reste.
_ADMIN_PW="${ITSM_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-}}"
if [ -n "$_ADMIN_PW" ]; then
  if python -m itsm_modern_ai.admin_setup --check >/dev/null 2>&1; then
    echo "[entrypoint] admin déjà configuré — amorçage ignoré (idempotent)"
  elif ITSM_ADMIN_PASSWORD="$_ADMIN_PW" python -m itsm_modern_ai.admin_setup; then
    echo "[entrypoint] compte admin amorcé (ITSM_ADMIN_PASSWORD / ADMIN_PASSWORD)"
  else
    # Mot de passe trop court (<8), base illisible, etc. : on log et on continue.
    echo "[entrypoint] amorçage admin échoué — démarrage quand même (définir le mot de passe via l'UI)" >&2
  fi
fi

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
