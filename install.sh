#!/usr/bin/env bash
# On-premise installer — COMMUNITY edition.
#
# Checks prerequisites (offers to install missing ones), prepares config, starts the
# service, creates the admin account, then prints a final CHECKLIST of system state.
#
# Usage:
#   ./install.sh                          # build from source + install
#   ./install.sh --bundle itsm.tar.gz     # load an offline image (no build)
#   ./install.sh --no-build               # use an image already present locally
#   ./install.sh --port 8080              # publish on a different host port
#   ./install.sh --yes                    # non-interactive (accept proposed installs)
#   ./install.sh --reset-password         # change the admin password of an instance
#
# The admin password is entered interactively (hidden) and stored ONLY as an encrypted
# Argon2 hash (never in clear text). In non-interactive mode, set ITSM_ADMIN_PASSWORD.
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
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac; shift
done

# ── Output helpers ──────────────────────────────────────────────────────────
c_cyan=$'\033[1;36m'; c_red=$'\033[1;31m'; c_grn=$'\033[1;32m'; c_yel=$'\033[1;33m'; c_off=$'\033[0m'
say()  { printf '%s▶ %s%s\n' "$c_cyan" "$1" "$c_off"; }
warn() { printf '%s! %s%s\n' "$c_yel" "$1" "$c_off"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$1" "$c_off" >&2; exit 1; }
ask()  { # ask "question" → 0 if yes. --yes => yes; no TTY => no.
  $ASSUME_YES && return 0
  [ -t 0 ] || return 1
  local r; read -r -p "$(printf '%s? %s [y/N] %s' "$c_yel" "$1" "$c_off")" r
  [[ "$r" =~ ^[oOyY]$ ]]
}

CHECKS=()
check_add() { CHECKS+=("$1"$'\t'"$2"); }

# ── Distro / package-manager detection ────────────────────────────────────────
OS_ID="unknown"; OS_NAME="unknown"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_NAME="${PRETTY_NAME:-$OS_ID}"
fi
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
PKG=""
for p in apt-get dnf yum zypper pacman apk; do command -v "$p" >/dev/null 2>&1 && { PKG="$p"; break; }; done

pkg_install() { # pkg_install "pkg1 pkg2"
  case "$PKG" in
    apt-get) $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y $1 ;;
    dnf|yum) $SUDO "$PKG" install -y $1 ;;
    zypper)  $SUDO zypper --non-interactive install $1 ;;
    pacman)  $SUDO pacman -S --noconfirm $1 ;;
    apk)     $SUDO apk add $1 ;;
    *) return 1 ;;
  esac
}

# Install the Docker Compose v2 CLI plugin via the official binary (works on ANY distro
# /arch without configuring Docker's apt/dnf repo — the `docker-compose-plugin` package
# is only available from Docker's own repo, which is often not configured).
install_compose_plugin() {
  command -v curl >/dev/null 2>&1 || pkg_install curl >/dev/null 2>&1 || true
  command -v curl >/dev/null 2>&1 || { warn "curl is required to fetch the compose plugin."; return 1; }
  local arch; arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    armv7l) arch=armv7 ;;
    *) warn "unsupported arch '$arch' for auto compose install."; return 1 ;;
  esac
  local url="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}"
  # Prefer system-wide cli-plugins dir; fall back to the user's.
  for dest in /usr/local/lib/docker/cli-plugins "$HOME/.docker/cli-plugins"; do
    local SU=""; [ "$dest" = "/usr/local/lib/docker/cli-plugins" ] && SU="$SUDO"
    $SU mkdir -p "$dest" 2>/dev/null || continue
    if $SU curl -fsSL "$url" -o "$dest/docker-compose" 2>/dev/null; then
      $SU chmod +x "$dest/docker-compose"
      docker compose version >/dev/null 2>&1 && return 0
    fi
  done
  return 1
}

# ── 1) Prerequisite preflight ───────────────────────────────────────────────
say "Checking prerequisites (detected OS: ${OS_NAME})"

# Docker CLI
if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  if ask "Install Docker now (official get.docker.com script)"; then
    if command -v curl >/dev/null 2>&1; then curl -fsSL https://get.docker.com | $SUDO sh
    else pkg_install "docker.io" || die "Auto-install failed — please install Docker manually."; fi
  else
    die "Docker is required. See https://docs.docker.com/get-docker/"
  fi
fi
command -v docker >/dev/null 2>&1 && check_add "Docker CLI" ok || die "Docker not found after install."

# Docker daemon reachable + permissions
if ! docker info >/dev/null 2>&1; then
  warn "Docker daemon not responding (not started, or missing permissions)."
  if command -v systemctl >/dev/null 2>&1 && ask "Try to start the docker service"; then
    $SUDO systemctl enable --now docker || true
  fi
  docker info >/dev/null 2>&1 || die "Docker daemon unreachable. Start it (sudo systemctl start docker) or add your user to the 'docker' group (then re-login)."
fi
check_add "Docker daemon" ok

# docker compose v2
if ! docker compose version >/dev/null 2>&1; then
  warn "The 'docker compose' v2 plugin is missing."
  if ask "Install the docker compose plugin (official binary)"; then
    install_compose_plugin || pkg_install "docker-compose-plugin" || true
  fi
  docker compose version >/dev/null 2>&1 || die "'docker compose' v2 is required (https://docs.docker.com/compose/install/)."
fi
check_add "docker compose v2" ok

# Disk space (>= 2 GB recommended for build + images)
free_kb="$(df -Pk . | awk 'NR==2{print $4}')"
if [ "${free_kb:-0}" -ge 2000000 ]; then check_add "Disk space (>=2 GB)" ok
else check_add "Disk space (>=2 GB)" "warn:$(( free_kb/1024 )) MB free"; warn "Low free disk space."; fi

# Host port free?
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  exec 3>&- 3<&- 2>/dev/null || true
  warn "Port ${PORT} seems already in use (maybe an existing instance)."
  check_add "Port ${PORT} free" "warn:in use"
else
  check_add "Port ${PORT} free" ok
fi

# ── 2) Minimal config (.env) ────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "Creating .env from .env.example (MASTER_KEY generated on first start in ./data)"
  cp .env.example .env
fi
check_add ".env file" ok
export ITSM_HOST_PORT="$PORT"

# ── 3) Image: offline bundle OR build from source ─────────────────────────────
IMAGE="${ITSM_IMAGE:-itsm-modern-ai-community:latest}"
if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || die "Bundle not found: $BUNDLE"
  say "Loading image from $BUNDLE (offline)"
  loaded="$(docker load -i "$BUNDLE" | sed -n 's/^Loaded image: //p' | head -1)"
  [ -n "$loaded" ] && IMAGE="$loaded"
  DO_BUILD=false
fi
export ITSM_IMAGE="$IMAGE"

if [ "$DO_BUILD" = auto ]; then
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then DO_BUILD=false; else DO_BUILD=true; fi
fi

if [ "$DO_BUILD" = true ]; then
  [ -f Dockerfile ] || die "No Dockerfile (sources missing) and image $IMAGE absent — provide --bundle."
  say "Building image '$IMAGE' (a few minutes on first run)…"
  # Build with the engine builder directly (NOT `docker compose build`): compose v2
  # delegates to buildx >= 0.17, which is often absent (e.g. distro 'docker.io'). A plain
  # `docker build` uses buildx if present, else the engine's classic builder — works on
  # far more setups. If BuildKit/buildx IS installed it's used transparently.
  docker build -t "$IMAGE" . || die "Image build failed (see output above)."
  say "Starting"
  docker compose up -d || die "Start failed (see: docker compose logs)."
  check_add "Image built" ok
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "Image $IMAGE absent. Provide --bundle or drop --no-build."
  say "Starting with image $IMAGE (no build)"
  docker compose up -d || die "Start failed (see: docker compose logs)."
  check_add "Image present ($IMAGE)" ok
fi

# ── 4) Wait until the engine is healthy (migrations + API) ─────────────────────
say "Waiting for the engine to start…"
cid="$(docker compose ps -q itsm 2>/dev/null || true)"
st="starting"
for _ in $(seq 1 "${HEALTH_TIMEOUT_TRIES:-150}"); do
  st="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$st" = "healthy" ] && break
  sleep 2
done
[ "$st" = "healthy" ] && check_add "Container healthy" ok || { check_add "Container healthy" "fail:$st"; die "Engine did not become healthy (see: docker compose logs)."; }

# ── 5) Admin account ───────────────────────────────────────────────────────────
admin_setup() {
  if [ -t 0 ]; then docker compose exec itsm python -m itsm_modern_ai.admin_setup "$@"
  elif [ -n "${ITSM_ADMIN_PASSWORD:-}" ]; then docker compose exec -T -e ITSM_ADMIN_PASSWORD itsm python -m itsm_modern_ai.admin_setup "$@"
  else die "No interactive terminal: set ITSM_ADMIN_PASSWORD for a non-interactive install."; fi
}
if [ "$RESET" = true ]; then
  say "Resetting the administrator password"; admin_setup --force
elif docker compose exec -T itsm python -m itsm_modern_ai.admin_setup --check >/dev/null 2>&1; then
  say "An administrator password is already configured — left unchanged."
else
  say "Creating the administrator account"; admin_setup
fi
docker compose exec -T itsm python -m itsm_modern_ai.admin_setup --check >/dev/null 2>&1 \
  && check_add "Admin password" ok || check_add "Admin password" "warn:not configured"

# ── 6) Runtime checks ────────────────────────────────────────────────────────
if docker compose exec -T itsm python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)" >/dev/null 2>&1; then
  check_add "API /health" ok
else
  check_add "API /health" "fail"
fi
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
check_add "Edition" "ok:${edition:-unknown}"

# ── Final checklist ─────────────────────────────────────────────────────────────
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
  printf '%s✅ Installation successful — console: http://localhost:%s%s\n' "$c_grn" "$PORT" "$c_off"
  echo "   Configure GLPI, the LLM provider and the scope from the web console."
  echo "   Upgrade to Enterprise later: ./upgrade-to-enterprise.sh \"<key>\""
else
  die "Some checks failed (see above)."
fi
