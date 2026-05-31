#!/usr/bin/env bash
# Installation on-premise — édition COMMUNITY.
#
# Vérifie les prérequis (et propose de les installer), prépare la config, démarre le
# service, crée le compte admin, puis affiche une CHECKLIST finale de l'état du système.
#
# Usage :
#   ./install.sh                          # build depuis les sources + install
#   ./install.sh --bundle itsm.tar.gz     # charge une image hors-ligne (pas de build)
#   ./install.sh --no-build               # utilise une image déjà présente localement
#   ./install.sh --port 8080              # publie sur un autre port hôte
#   ./install.sh --yes                    # non-interactif (accepte les installs proposées)
#   ./install.sh --reset-password         # change le mot de passe admin d'une instance
#
# Le mot de passe admin est saisi en interactif (getpass) et stocké UNIQUEMENT en hash
# Argon2 chiffré (jamais en clair). En non-interactif, fournir ITSM_ADMIN_PASSWORD.
set -uo pipefail
cd "$(dirname "$0")"

# ── Options ─────────────────────────────────────────────────────────────────
RESET=false; ASSUME_YES=false; DO_BUILD=auto; BUNDLE=""; PORT="${ITSM_PORT:-8000}"
while [ $# -gt 0 ]; do
  case "$1" in
    --reset-password) RESET=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --no-build) DO_BUILD=false ;;
    --bundle) BUNDLE="${2:-}"; shift ;;
    --port) PORT="${2:-8000}"; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "option inconnue: $1" >&2; exit 2 ;;
  esac; shift
done

# ── Affichage ─────────────────────────────────────────────────────────────────
c_cyan=$'\033[1;36m'; c_red=$'\033[1;31m'; c_grn=$'\033[1;32m'; c_yel=$'\033[1;33m'; c_off=$'\033[0m'
say()  { printf '%s▶ %s%s\n' "$c_cyan" "$1" "$c_off"; }
warn() { printf '%s! %s%s\n' "$c_yel" "$1" "$c_off"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$1" "$c_off" >&2; exit 1; }
ask()  { # ask "question" → 0 si oui. --yes => oui ; pas de TTY => non.
  $ASSUME_YES && return 0
  [ -t 0 ] || return 1
  local r; read -r -p "$(printf '%s? %s [o/N] %s' "$c_yel" "$1" "$c_off")" r
  [[ "$r" =~ ^[oOyY]$ ]]
}

# Checklist accumulée (label\tétat) affichée à la fin.
CHECKS=()
check_add() { CHECKS+=("$1"$'\t'"$2"); }

# Détection du gestionnaire de paquets (pour proposer une install).
PKG=""; SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
for p in apt-get dnf yum zypper pacman; do command -v "$p" >/dev/null 2>&1 && { PKG="$p"; break; }; done

pkg_install() { # pkg_install "paquet1 paquet2"
  case "$PKG" in
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y $1 ;;
    dnf|yum) $SUDO "$PKG" install -y $1 ;;
    zypper)  $SUDO zypper install -y $1 ;;
    pacman)  $SUDO pacman -S --noconfirm $1 ;;
    *) return 1 ;;
  esac
}

# ── 1) Préflight des prérequis ─────────────────────────────────────────────────
say "Vérification des prérequis"

# Docker CLI
if ! command -v docker >/dev/null 2>&1; then
  warn "Docker n'est pas installé."
  if ask "Installer Docker maintenant (script officiel get.docker.com)"; then
    if command -v curl >/dev/null 2>&1; then curl -fsSL https://get.docker.com | $SUDO sh
    else pkg_install "docker.io" || die "Installation auto impossible — installez Docker manuellement."; fi
  else
    die "Docker est requis. Voir https://docs.docker.com/get-docker/"
  fi
fi
command -v docker >/dev/null 2>&1 && check_add "Docker CLI" ok || die "Docker introuvable après installation."

# Démon Docker joignable + permissions
if ! docker info >/dev/null 2>&1; then
  warn "Le démon Docker ne répond pas (non démarré, ou permissions manquantes)."
  if command -v systemctl >/dev/null 2>&1 && ask "Tenter de démarrer le service docker"; then
    $SUDO systemctl enable --now docker || true
  fi
  docker info >/dev/null 2>&1 || die "Démon Docker injoignable. Démarrez-le (sudo systemctl start docker) ou ajoutez votre user au groupe 'docker' (puis reconnectez-vous)."
fi
check_add "Démon Docker" ok

# docker compose v2
if ! docker compose version >/dev/null 2>&1; then
  warn "Le plugin 'docker compose' (v2) est absent."
  if ask "Installer le plugin docker compose"; then
    pkg_install "docker-compose-plugin" || warn "Installation auto impossible."
  fi
  docker compose version >/dev/null 2>&1 || die "Plugin 'docker compose' requis (https://docs.docker.com/compose/install/)."
fi
check_add "docker compose v2" ok

# Espace disque (>= 2 Go conseillé pour build + images)
free_kb="$(df -Pk . | awk 'NR==2{print $4}')"
if [ "${free_kb:-0}" -ge 2000000 ]; then check_add "Espace disque (≥2 Go)" ok
else check_add "Espace disque (≥2 Go)" "warn:$(( free_kb/1024 )) Mo libres"; warn "Peu d'espace disque libre."; fi

# Port hôte libre ?
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  exec 3>&- 3<&- 2>/dev/null || true
  warn "Le port ${PORT} semble déjà utilisé (peut-être une instance existante)."
  check_add "Port ${PORT} libre" "warn:occupé"
else
  check_add "Port ${PORT} libre" ok
fi

# ── 2) Configuration minimale (.env) ───────────────────────────────────────────
if [ ! -f .env ]; then
  say "Création de .env depuis .env.example (MASTER_KEY générée au 1er démarrage dans ./data)"
  cp .env.example .env
fi
check_add "Fichier .env" ok
# Port hôte appliqué via override compose (sans éditer docker-compose.yml).
export ITSM_HOST_PORT="$PORT"

# ── 3) Image : bundle hors-ligne OU build depuis les sources ───────────────────
IMAGE="${ITSM_IMAGE:-itsm-modern-ai-community:latest}"
if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || die "Bundle introuvable : $BUNDLE"
  say "Chargement de l'image depuis $BUNDLE (hors-ligne)"
  loaded="$(docker load -i "$BUNDLE" | sed -n 's/^Loaded image: //p' | head -1)"
  [ -n "$loaded" ] && IMAGE="$loaded"
  DO_BUILD=false
fi
export ITSM_IMAGE="$IMAGE"

if [ "$DO_BUILD" = auto ]; then
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then DO_BUILD=false; else DO_BUILD=true; fi
fi

if [ "$DO_BUILD" = true ]; then
  [ -f Dockerfile ] || die "Pas de Dockerfile (sources absentes) et image $IMAGE absente — fournissez --bundle."
  say "Build de l'image puis démarrage"
  docker compose up -d --build || die "Échec du build/démarrage (voir: docker compose logs)."
  check_add "Image construite" ok
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "Image $IMAGE absente. Fournissez --bundle ou retirez --no-build."
  say "Démarrage avec l'image $IMAGE (sans build)"
  docker compose up -d || die "Échec du démarrage (voir: docker compose logs)."
  check_add "Image présente ($IMAGE)" ok
fi

# ── 4) Attente que le moteur soit sain (migrations + API) ──────────────────────
say "Attente du démarrage du moteur…"
cid="$(docker compose ps -q itsm 2>/dev/null || true)"
st="starting"
for _ in $(seq 1 "${HEALTH_TIMEOUT_TRIES:-150}"); do
  st="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$st" = "healthy" ] && break
  sleep 2
done
[ "$st" = "healthy" ] && check_add "Conteneur healthy" ok || { check_add "Conteneur healthy" "fail:$st"; die "Le moteur n'est pas devenu sain (voir: docker compose logs)."; }

# ── 5) Compte administrateur ───────────────────────────────────────────────────
admin_setup() {
  if [ -t 0 ]; then docker compose exec itsm python -m itsm_modern_ai.admin_setup "$@"
  elif [ -n "${ITSM_ADMIN_PASSWORD:-}" ]; then docker compose exec -T -e ITSM_ADMIN_PASSWORD itsm python -m itsm_modern_ai.admin_setup "$@"
  else die "Pas de terminal interactif : définissez ITSM_ADMIN_PASSWORD pour une install non-interactive."; fi
}
if [ "$RESET" = true ]; then
  say "Réinitialisation du mot de passe administrateur"; admin_setup --force
elif docker compose exec -T itsm python -m itsm_modern_ai.admin_setup --check >/dev/null 2>&1; then
  say "Un mot de passe administrateur est déjà configuré — inchangé."
else
  say "Création du compte administrateur"; admin_setup
fi
docker compose exec -T itsm python -m itsm_modern_ai.admin_setup --check >/dev/null 2>&1 \
  && check_add "Mot de passe admin" ok || check_add "Mot de passe admin" "warn:non configuré"

# ── 6) Vérifs runtime ───────────────────────────────────────────────────────────
# /health via le conteneur (pas de dépendance à curl sur l'hôte).
if docker compose exec -T itsm python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)" >/dev/null 2>&1; then
  check_add "API /health" ok
else
  check_add "API /health" "fail"
fi
# Édition active (Community attendu en l'absence de licence).
edition="$(docker compose exec -T itsm python -c "
from datetime import date
from itsm_modern_ai.config.settings import get_settings
from itsm_modern_ai.services.runtime_config import RuntimeConfigService
from itsm_modern_ai.persistence import db
from itsm_modern_ai.api.runtime import make_secrets_box
from itsm_modern_ai.domain.licensing import verify_license
s=get_settings(); db.init_engine(s.database_url); box=make_secrets_box(s)
with db.session_scope() as ss:
    cfg=RuntimeConfigService(ss,box,s)
    print(verify_license(cfg.get('license_key') or '', today=date.today()).edition)
" 2>/dev/null | tr -d '\r')"
check_add "Édition" "ok:${edition:-inconnue}"

# ── Checklist finale ────────────────────────────────────────────────────────────
echo
printf '%s──────── CHECKLIST ────────%s\n' "$c_cyan" "$c_off"
allgood=true
for line in "${CHECKS[@]}"; do
  label="${line%%$'\t'*}"; statefull="${line#*$'\t'}"
  state="${statefull%%:*}"; detail=""; [ "$statefull" != "$state" ] && detail=" (${statefull#*:})"
  case "$state" in
    ok)   printf '  %s✓%s %s%s\n' "$c_grn" "$c_off" "$label" "$detail" ;;
    warn) printf '  %s!%s %s%s\n' "$c_yel" "$c_off" "$label" "$detail" ;;
    *)    printf '  %s✗%s %s%s\n' "$c_red" "$c_off" "$label" "$detail"; allgood=false ;;
  esac
done
echo
if $allgood; then
  printf '%s✅ Installation réussie — console : http://localhost:%s%s\n' "$c_grn" "$PORT" "$c_off"
  echo "   Configurez GLPI, le fournisseur LLM et le périmètre dans l'interface."
  echo "   Passer en Enterprise plus tard : ./upgrade-to-enterprise.sh \"<clé>\""
else
  die "Des vérifications ont échoué (voir ci-dessus)."
fi
