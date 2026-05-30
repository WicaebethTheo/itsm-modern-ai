#!/usr/bin/env bash
# Installation on-premise en une commande : build + démarrage + création du compte admin.
#
#   ./install.sh                   # installe et demande un mot de passe admin (masqué)
#   ./install.sh --reset-password  # change le mot de passe admin d'une instance existante
#
# Le mot de passe est saisi en interactif et stocké UNIQUEMENT en hash Argon2 chiffré
# (jamais en clair dans .env). La config (GLPI, LLM, périmètre) se fait ensuite dans l'UI.
set -euo pipefail
cd "$(dirname "$0")"

RESET=false
[ "${1:-}" = "--reset-password" ] && RESET=true

say() { printf '\033[1;36m▶ %s\033[0m\n' "$1"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# 1. Prérequis
command -v docker >/dev/null 2>&1 || die "Docker est requis (https://docs.docker.com/get-docker/)."
docker compose version >/dev/null 2>&1 || die "Le plugin 'docker compose' est requis."

# 2. Configuration minimale (.env). MASTER_KEY vide → clé générée et persistée dans data/.
if [ ! -f .env ]; then
  say "Création de .env depuis .env.example"
  cp .env.example .env
fi

# 3. Build + démarrage (l'entrypoint applique les migrations Alembic au boot)
say "Build de l'image et démarrage du service"
docker compose up -d --build

# 4. Attente que le moteur soit prêt (migrations terminées + API up)
say "Attente du démarrage du moteur…"
for _ in $(seq 1 60); do
  st="$(docker inspect --format '{{.State.Health.Status}}' itsm-modern-ai 2>/dev/null || echo starting)"
  [ "$st" = "healthy" ] && break
  sleep 2
done
[ "${st:-}" = "healthy" ] || die "Le moteur n'est pas devenu sain à temps (voir: docker compose logs)."

# 5. Compte administrateur
if [ "$RESET" = true ]; then
  say "Réinitialisation du mot de passe administrateur"
  docker compose exec itsm python -m itsm_modern_ai.admin_setup --force
elif docker compose exec -T itsm python -m itsm_modern_ai.admin_setup --check >/dev/null 2>&1; then
  say "Un mot de passe administrateur est déjà configuré — inchangé."
  echo "   (pour le changer : ./install.sh --reset-password)"
else
  say "Création du compte administrateur"
  docker compose exec itsm python -m itsm_modern_ai.admin_setup
fi

printf '\033[1;32m✅ Installation terminée — console : http://localhost:8000\033[0m\n'
echo "   Configurez GLPI, le fournisseur LLM et le périmètre directement dans l'interface."
