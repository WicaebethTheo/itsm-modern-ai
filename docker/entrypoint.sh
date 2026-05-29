#!/usr/bin/env bash
# Applique les migrations (Alembic = source de vérité) puis démarre le moteur.
set -euo pipefail

# Durcissement : si on démarre en root (cas par défaut), on s'assure que le volume
# monté ./data appartient à l'utilisateur non-root `app` (il peut être root sur un
# déploiement existant), puis on RELANCE ce script en `app` via gosu. Au second
# passage (id != 0), on saute ce bloc et on exécute le moteur sans privilèges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R app:app /app/data
  echo "[entrypoint] passage en utilisateur non-root « app »"
  exec gosu app "$0" "$@"
fi

echo "[entrypoint] alembic upgrade head"
alembic upgrade head

# Reverse proxy : si TRUST_PROXY_HEADERS=true, on active la lecture de XFF côté
# uvicorn (cf. docs/install.md §5). `--forwarded-allow-ips=*` car le moteur n'est
# joignable que via le proxy en pilote conteneurisé.
if [ "${TRUST_PROXY_HEADERS:-false}" = "true" ]; then
  PROXY_ARGS="--proxy-headers --forwarded-allow-ips=*"
else
  PROXY_ARGS=""
fi

echo "[entrypoint] démarrage uvicorn"
exec uvicorn itsm_modern_ai.main:app --host 0.0.0.0 --port 8000 $PROXY_ARGS
