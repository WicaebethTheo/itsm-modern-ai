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
#   ./install.sh --update                 # UPDATE: git pull latest code + rebuild + restart
#   ./install.sh --build                  # force a rebuild of the current code (no pull)
#   ./install.sh --port 8080              # publish on a different host port
#   ./install.sh --yes                    # non-interactive (accept proposed installs)
#   ./install.sh --reset-password         # change the admin password of an instance
#
# The admin password is entered interactively (hidden) and stored ONLY as an encrypted
# Argon2 hash (never in clear text). In non-interactive mode, set ITSM_ADMIN_PASSWORD.
set -uo pipefail
cd "$(dirname "$0")"

# ── Options ─────────────────────────────────────────────────────────────────
RESET=false; ASSUME_YES=false; DO_BUILD=auto; BUNDLE=""; PORT="${ITSM_PORT:-8000}"; SELF_UPDATE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --reset-password) RESET=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --update) DO_BUILD=true; SELF_UPDATE=true ;;  # git pull + rebuild
    --build) DO_BUILD=true ;;                     # rebuild current code (no pull)
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
# Durcissement : .env peut contenir un secret d'amorçage (ITSM_ADMIN_PASSWORD/ADMIN_PASSWORD
# en mode non-interactif) → propriétaire seul (jamais world-readable).
chmod 600 .env 2>/dev/null || true
check_add ".env file (chmod 600)" ok
export ITSM_HOST_PORT="$PORT"

# ── 2b) Self-update (--update): pull the latest code BEFORE rebuilding ─────────
# `./install.sh --update` = one-command update: fetch the latest code (git) and rebuild
# the image; ./data (config + DB + master.key) is preserved across the rebuild.
# In offline/bundle mode (no git checkout) the pull is skipped (use --bundle to update).
if [ "$SELF_UPDATE" = true ]; then
  if [ -d .git ] && command -v git >/dev/null 2>&1; then
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo master)"
    say "Updating source (git pull, branch: $branch)…"
    if git fetch --depth 1 origin "$branch" && git reset --hard "origin/$branch"; then
      check_add "Source updated (git)" ok
    else
      warn "git update failed — rebuilding the current code instead."
      check_add "Source updated (git)" "warn:git pull failed"
    fi
  else
    warn "Not a git checkout — skipping source pull (use --bundle for offline updates)."
    check_add "Source updated (git)" "warn:not a git checkout"
  fi
fi

# ── 3) Image: offline bundle OR build from source ─────────────────────────────
# Image UNIQUE : un seul tag, fixé par docker-compose.yml. Les features Supporter sont
# livrées dedans et déverrouillées par licence (pas de swap d'image).
IMAGE="itsm-modern-ai:latest"
if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || die "Bundle not found: $BUNDLE"
  say "Loading image from $BUNDLE (offline)"
  loaded="$(docker load -i "$BUNDLE" | sed -n 's/^Loaded image: //p' | head -1)"
  # Retague l'image chargée sous le tag attendu par compose (édition unique).
  [ -n "$loaded" ] && [ "$loaded" != "$IMAGE" ] && docker tag "$loaded" "$IMAGE"
  DO_BUILD=false
fi

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

# ── 4) Wait until the engine SERVES (independent of GLPI/LLM reachability) ──────
# We poll /api/status (public, no external deps) → 200 means the HTTP server is up.
# We do NOT wait for Docker's `healthy` state: its healthcheck probes GLPI/LLM, so a
# fresh install (GLPI/LLM not yet configured, or unreachable) stays "degraded" forever
# even though the engine is fine — that used to hang this script. We also FAIL FAST if
# the container crashes (e.g. bad MASTER_KEY), printing the logs instead of waiting.
say "Waiting for the engine to start…"
cid="$(docker compose ps -q itsm 2>/dev/null || true)"
[ -n "$cid" ] || cid="$(docker ps -q -f name=itsm-modern-ai | head -1)"
ready=false
for _ in $(seq 1 "${HEALTH_TIMEOUT_TRIES:-90}"); do
  state="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
  if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
    echo; warn "The engine container crashed. Recent logs:"
    docker compose logs --tail=40 itsm 2>/dev/null || docker logs --tail=40 "$cid" 2>/dev/null || true
    check_add "Engine reachable" "fail:crashed"
    die "Engine crashed at startup (see logs above) — fix the cause and re-run."
  fi
  if docker exec "$cid" python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/status').status==200 else 1)" >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 2
done
if $ready; then
  check_add "Engine reachable" ok
else
  echo; warn "Engine did not respond in time. Recent logs:"
  docker compose logs --tail=40 itsm 2>/dev/null || true
  check_add "Engine reachable" "fail:timeout"
  die "Engine did not become ready in time (see logs above)."
fi

# ── 5) Admin account — REQUIRED (the console must never be left unprotected) ────
admin_is_set() { docker compose exec -T itsm python -m itsm_modern_ai.admin_setup --check >/dev/null 2>&1; }
run_admin_setup() {  # "$@" → extra flags ; returns the setup exit code
  if [ -t 0 ]; then docker compose exec itsm python -m itsm_modern_ai.admin_setup "$@"
  elif [ -n "${ITSM_ADMIN_PASSWORD:-}" ]; then docker compose exec -T -e ITSM_ADMIN_PASSWORD itsm python -m itsm_modern_ai.admin_setup "$@"
  else die "No interactive terminal and ITSM_ADMIN_PASSWORD unset — an admin password is REQUIRED."; fi
}
if [ "$RESET" = true ]; then
  say "Resetting the administrator password (required)"; run_admin_setup --force || true
elif admin_is_set; then
  say "An administrator password is already configured — left unchanged."
fi
# Enforce: a password MUST be set. Interactive → retry until set (typo/too short).
if ! admin_is_set; then
  if [ -t 0 ]; then
    tries=0
    until admin_is_set; do
      tries=$((tries+1)); [ "$tries" -gt 5 ] && die "Admin password still not set after several attempts."
      say "Set the administrator password — REQUIRED (min. 8 characters)"
      run_admin_setup || warn "Not set (mismatch or too short) — try again."
    done
  else
    run_admin_setup || true
    admin_is_set || die "Could not set the admin password from ITSM_ADMIN_PASSWORD (min. 8 chars)."
  fi
fi
# Hard gate: refuse to finish if there is still no admin password.
admin_is_set && check_add "Admin password" ok \
  || { check_add "Admin password" fail; die "No admin password configured — refusing to finish (console would be UNPROTECTED)."; }

# ── 6) Runtime checks ────────────────────────────────────────────────────────
# /health reflète GLPI+LLM : 503 si l'un est configuré-injoignable (ou pas encore
# configuré). Ce n'est PAS un échec d'install (on configure GLPI/LLM dans l'UI ensuite) →
# 200 = ok, 503 = warn (à configurer), pas de réponse = fail.
hc="$(docker compose exec -T itsm python -c "import urllib.request
try:
    print(urllib.request.urlopen('http://localhost:8000/health').status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print('down')" 2>/dev/null | tr -d '\r' | tail -1)"
case "$hc" in
  200) check_add "API /health" ok ;;
  ""|down) check_add "API /health" "fail" ;;
  *) check_add "API /health" "warn:HTTP $hc — GLPI/LLM à configurer dans l'UI" ;;
esac
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
# Open-admin mode bypasses login ONLY when no password is set; we now force one, but
# warn loudly if it's enabled so it isn't left on by accident in production.
if docker compose exec -T itsm python -c "from itsm_modern_ai.config.settings import get_settings as g; import sys; sys.exit(0 if g().dev_open_admin else 1)" >/dev/null 2>&1; then
  check_add "Open-admin (DEV_OPEN_ADMIN)" "warn:ENABLED — disable for production (DEV_OPEN_ADMIN=false)"
fi

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
  echo "   Become Supporter later: paste your license key in the Supporter page of the console."
else
  die "Some checks failed (see above)."
fi
