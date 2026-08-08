#!/usr/bin/env bash
# On-premise installer — COMMUNITY edition.
#
# Checks prerequisites (offers to install missing ones), prepares config, starts the
# service, creates the admin account, then prints a final CHECKLIST of system state.
#
# Une seule commande pour TOUT : installer ET mettre à jour. Si une instance existe
# déjà dans ce dossier, un menu propose « Mettre à jour » (sauvegarde ./data incluse)
# ou « Réinstaller ». Pas de second script à connaître.
#
# Usage:
#   ./install.sh                          # installe ; si déjà installé → menu maj/réinstall
#   ./install.sh --bundle itsm.tar.gz     # load an offline image (no build)
#   ./install.sh --no-build               # use an image already present locally
#   ./install.sh --update                 # UPDATE non-interactif : sauvegarde + pull + rebuild
#   ./install.sh --build                  # force a rebuild of the current code (no pull)
#   ./install.sh --port 8080              # publish on a different host port
#   ./install.sh --yes                    # non-interactive (accept proposed installs)
#   ./install.sh --reset-password         # change the admin password of an instance
#   ./install.sh --rollback [horodatage]  # RETOUR ARRIERE : restaure backups/<ts> (base + cle + image)
#   ./install.sh --list-backups           # liste les sauvegardes disponibles
#
# The admin password is entered interactively (hidden) and stored ONLY as an encrypted
# Argon2 hash (never in clear text). In non-interactive mode, set ITSM_ADMIN_PASSWORD.
set -uo pipefail
cd "$(dirname "$0")"

# ── Options ─────────────────────────────────────────────────────────────────
RESET=false; ASSUME_YES=false; DO_BUILD=auto; BUNDLE=""; PORT="${ITSM_PORT:-8000}"; SELF_UPDATE=false; MODE_GIVEN=false
ROLLBACK=false; ROLLBACK_TS=""; LIST_BACKUPS=false
while [ $# -gt 0 ]; do
  case "$1" in
    --reset-password) RESET=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --update) DO_BUILD=true; SELF_UPDATE=true; MODE_GIVEN=true ;;  # git pull + rebuild
    --build) DO_BUILD=true; MODE_GIVEN=true ;;    # rebuild current code (no pull)
    --no-build) DO_BUILD=false ;;
    --bundle) BUNDLE="${2:-}"; MODE_GIVEN=true; shift ;;
    --port) PORT="${2:-8000}"; shift ;;
    # Retour arriere. L'horodatage est OPTIONNEL : sans argument on prend la sauvegarde
    # la plus recente (le cas d'usage reel : « la maj de tout a l'heure a casse »).
    --rollback) ROLLBACK=true; MODE_GIVEN=true
                case "${2:-}" in ""|-*) : ;; *) ROLLBACK_TS="$2"; shift ;; esac ;;
    --list-backups) LIST_BACKUPS=true; MODE_GIVEN=true ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac; shift
done

# ── Output helpers ──────────────────────────────────────────────────────────
c_cyan=$'\033[1;36m'; c_red=$'\033[1;31m'; c_grn=$'\033[1;32m'; c_yel=$'\033[1;33m'; c_off=$'\033[0m'
say()  { printf '%s▶ %s%s\n' "$c_cyan" "$1" "$c_off"; }
warn() { printf '%s! %s%s\n' "$c_yel" "$1" "$c_off"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$1" "$c_off" >&2; exit 1; }
ask()  { # 0 = oui. --yes => oui ; TTY (stdin OU /dev/tty, ex. curl|sh) => demande (defaut OUI) ; sinon => oui (auto, CI).
  $ASSUME_YES && return 0
  local r=""
  if [ -t 0 ]; then
    read -r -p "$(printf '%s? %s [O/n] %s' "$c_yel" "$1" "$c_off")" r
  elif [ -r /dev/tty ] && [ -t 1 ]; then
    printf '%s? %s [O/n] %s' "$c_yel" "$1" "$c_off" > /dev/tty
    IFS= read -r r < /dev/tty || r=""
  else
    return 0   # non-interactif (CI) : on installe les prerequis automatiquement
  fi
  case "$r" in [nN]*) return 1 ;; *) return 0 ;; esac
}

CHECKS=()
check_add() { CHECKS+=("$1"$'\t'"$2"); }

# Image UNIQUE : un seul tag, fixé par docker-compose.yml. Les features Supporter sont
# livrées dedans et déverrouillées par licence (pas de swap d'image). Défini TÔT :
# le retour arrière (--rollback) en a besoin avant la section « image ».
IMAGE="itsm-modern-ai:latest"

# ── Sauvegardes & RETOUR ARRIÈRE ──────────────────────────────────────────────
# Sans chemin de retour, une mise à jour ratée laisse un DSI seul devant un
# `docker logs` à 2 h du matin : revenir à l'image précédente SANS restaurer la base
# fait échouer Alembic (« Can't locate revision identified by … ») → l'entrypoint est
# en `set -e` → crash-loop, sans UI. `--rollback` restaure les DEUX ensemble.
backups_list() { ls -1 backups 2>/dev/null | sort; }
latest_backup() { backups_list | tail -1; }

show_backups() {
  local ts n
  n=0
  printf '%s▶ Sauvegardes disponibles (dossier ./backups)%s\n' "$c_cyan" "$c_off"
  for ts in $(backups_list); do
    [ -d "backups/$ts" ] || continue
    n=$((n+1))
    printf '   %s' "$ts"
    [ -f "backups/$ts/itsm.db" ] && printf '  base SQLite (%s)' "$(du -h "backups/$ts/itsm.db" | cut -f1)"
    [ -f "backups/$ts/dump.sql" ] && printf '  dump PostgreSQL'
    [ -f "backups/$ts/master.key" ] && printf '  + master.key'
    [ -f "backups/$ts/VERSION" ] && printf '  v%s' "$(cat "backups/$ts/VERSION")"
    printf '\n'
  done
  [ "$n" -gt 0 ] || echo "   (aucune — une sauvegarde est créée à chaque ./install.sh --update)"
  echo
  echo "   Restaurer : ./install.sh --rollback <horodatage>"
}

# Restaure une sauvegarde : base + master.key + code/image de l'époque, puis redémarre.
do_rollback() {
  local ts="$1" bk safe f img rev
  [ -n "$ts" ] || ts="$(latest_backup)"
  [ -n "$ts" ] || { show_backups; die "Aucune sauvegarde à restaurer."; }
  bk="backups/$ts"
  [ -d "$bk" ] || { show_backups; die "Sauvegarde introuvable : $bk"; }
  if [ ! -f "$bk/itsm.db" ] && [ ! -f "$bk/dump.sql" ]; then
    die "$bk ne contient aucune base ($bk/itsm.db ou $bk/dump.sql) — restauration impossible."
  fi
  say "Retour arrière vers la sauvegarde $ts"
  ask "Confirmer : l'état actuel sera MIS DE CÔTÉ (jamais supprimé) et remplacé par $ts" \
    || { say "Annulé — aucune modification."; exit 0; }

  # Port publié CONSERVÉ : sans cela, une instance installée avec --port 8080
  # ressusciterait sur 8000 après un rollback (console « disparue » pour les clients).
  local hp; hp="$(docker inspect --format \
    '{{range $c := .HostConfig.PortBindings}}{{(index $c 0).HostPort}}{{end}}' \
    itsm-modern-ai 2>/dev/null | head -1)"
  [ -n "$hp" ] && PORT="$hp"
  export ITSM_HOST_PORT="$PORT"
  say "Port publié conservé : $PORT"

  # 1) Arrêt du service (JAMAIS `down -v` : cela détruirait le volume de données).
  docker compose stop >/dev/null 2>&1 || true

  # 2) L'état courant est DÉPLACÉ, pas écrasé : un rollback raté reste réversible.
  safe="data/pre-rollback-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$safe"
  for f in data/itsm.db data/itsm.db-wal data/itsm.db-shm; do
    [ -e "$f" ] && mv "$f" "$safe/"
  done
  if [ -f "$bk/master.key" ] && [ -f data/master.key ]; then mv data/master.key "$safe/"; fi
  say "État précédent conservé dans $safe (à supprimer une fois le rollback validé)"

  # 3) Base + clé de chiffrement restaurées ENSEMBLE (une base sans sa clé est illisible).
  if [ -f "$bk/itsm.db" ]; then
    cp -a "$bk/itsm.db" data/itsm.db
    for f in itsm.db-wal itsm.db-shm; do [ -f "$bk/$f" ] && cp -a "$bk/$f" "data/$f"; done
    echo "  base SQLite restaurée depuis $bk/itsm.db"
  else
    warn "Sauvegarde PostgreSQL : la base N'EST PAS restaurée automatiquement (destructif)."
    warn "  docker compose --profile postgres up -d postgres"
    warn "  docker compose exec -T postgres psql -U itsm -d itsm < $bk/dump.sql"
  fi
  if [ -f "$bk/master.key" ]; then
    cp -a "$bk/master.key" data/master.key; chmod 600 data/master.key
    echo "  master.key restaurée"
  else
    warn "Pas de master.key dans $bk : MASTER_KEY doit venir de .env (valeur d'origine !)."
  fi

  # 4) Code + image de l'époque. L'image locale d'alors est réutilisée telle quelle si
  # elle est encore présente (instantané, hors-ligne) ; sinon on rebâtit depuis le
  # commit sauvegardé — indispensable pour que le schéma corresponde à la base restaurée.
  img=""; [ -f "$bk/IMAGE_ID" ] && img="$(cat "$bk/IMAGE_ID")"
  if [ -n "$img" ] && docker image inspect "$img" >/dev/null 2>&1; then
    docker tag "$img" "$IMAGE" && say "Image d'origine ré-étiquetée $IMAGE (aucun rebuild)"
  else
    rev=""; [ -f "$bk/GIT_REV" ] && rev="$(cat "$bk/GIT_REV")"
    if [ -n "$rev" ] && [ -d .git ] && command -v git >/dev/null 2>&1; then
      say "Image d'origine absente — retour du code au commit $rev puis rebuild"
      git checkout --force "$rev" >/dev/null 2>&1 || warn "git checkout $rev impossible (commit absent ?)."
      docker build -t "$IMAGE" . || die "Rebuild de l'image d'origine échoué — instance NON redémarrée, données restaurées dans ./data."
    else
      warn "Ni image ni commit d'origine connus : on redémarre avec l'image ACTUELLE."
      warn "Si le schéma est plus récent que la base restaurée, le moteur refusera de démarrer."
    fi
  fi

  # 5) Redémarrage — une instance ne doit JAMAIS rester à l'arrêt à la fin d'un rollback.
  docker compose up -d --force-recreate || die "Redémarrage échoué (voir : docker compose logs)."
  say "Retour arrière terminé — instance redémarrée."
  echo "   Vérifiez la console, puis supprimez $safe si tout est correct."
  exit 0
}

if $LIST_BACKUPS; then show_backups; exit 0; fi

# ── Sélecteur Installer / Mettre à jour ───────────────────────────────────────
# Une seule commande à connaître. Si une instance existe déjà dans ce dossier, on
# propose le choix Mettre à jour (sauvegarde ./data incluse) ou Réinstaller —
# inutile de connaître/lancer un second script. En non-interactif (pipe sans TTY,
# CI), on choisit la mise à jour par défaut. Le menu est court-circuité si un mode
# explicite est passé (--update, --bundle, --build, --reset-password).
instance_exists() { [ -d data ] && { [ -f data/master.key ] || ls data/*.db* >/dev/null 2>&1; }; }
if [ "$RESET" = false ] && [ "$MODE_GIVEN" = false ] && instance_exists; then
  choice=1
  if [ -r /dev/tty ] && [ -t 1 ]; then
    {
      printf '\n%s▶ Une instance ITSM Modern AI est déjà installée ici.%s\n' "$c_cyan" "$c_off"
      printf '   1) Mettre à jour    — sauvegarde ./data, dernière version, reconstruit  [défaut]\n'
      printf '   2) Réinstaller / reconfigurer\n'
      printf '   3) Quitter\n'
      printf '%s? Votre choix [1] : %s' "$c_yel" "$c_off"
    } > /dev/tty
    IFS= read -r choice < /dev/tty || choice=1
  fi
  case "${choice:-1}" in
    2) say "Réinstallation / reconfiguration de l'instance existante" ;;
    3) say "Annulé — aucune modification."; exit 0 ;;
    *) say "Mise à jour de l'instance existante"; SELF_UPDATE=true; DO_BUILD=true ;;
  esac
fi

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
    apt-get) $SUDO apt-get update -qq && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y $1 ;;
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
  warn "Daemon Docker injoignable — tentative de demarrage..."
  $SUDO systemctl enable --now docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
  # Le daemon met quelques secondes a etre pret apres un demarrage/install -> on patiente.
  for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
if ! docker info >/dev/null 2>&1; then
  if $SUDO docker info >/dev/null 2>&1; then
    warn "Le daemon tourne mais votre utilisateur n'a pas acces au socket Docker."
    warn "Ajoutez-vous au groupe : sudo usermod -aG docker \"\$USER\" puis reconnectez-vous (ou relancez en root)."
  else
    warn "Le daemon Docker n'a pas demarre. Diagnostic :"
    { $SUDO systemctl status docker --no-pager -l 2>/dev/null | tail -15; } \
      || { $SUDO journalctl -u docker --no-pager -n 15 2>/dev/null; } || true
    warn "Conteneur Proxmox/LXC ? Docker exige un LXC PRIVILEGIE (ou options nesting=1 + keyctl=1), sinon utilisez une vraie VM."
  fi
  die "Daemon Docker injoignable (voir ci-dessus). Demarrez-le (sudo systemctl start docker) puis relancez."
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

# Retour arrière : dès que Docker + compose répondent, on n'a besoin de rien d'autre
# (ni port libre, ni .env, ni build) — do_rollback se termine par `exit`.
if $ROLLBACK; then do_rollback "$ROLLBACK_TS"; fi

# Disk space (>= 2 GB recommended for build + images)
free_kb="$(df -Pk . | awk 'NR==2{print $4}')"
if [ "${free_kb:-0}" -ge 2000000 ]; then check_add "Disk space (>=2 GB)" ok
else check_add "Disk space (>=2 GB)" "warn:$(( free_kb/1024 )) MB free"; warn "Low free disk space."; fi

# Host port free?
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  # ⚠️ Les accolades sont INDISPENSABLES : `exec 3>&- 3<&- 2>/dev/null` sans commande
  # applique ses redirections au shell COURANT — la stderr du script partait alors
  # définitivement dans /dev/null dès que le port était occupé (cas de TOUTE mise à
  # jour !), masquant les erreurs de `docker build` et jusqu'aux messages de `die`.
  { exec 3>&- 3<&-; } 2>/dev/null || true
  warn "Port ${PORT} deja utilise (probablement une instance existante)."
  if ! instance_exists; then
    warn "Aucune instance dans CE dossier, mais le port ${PORT} est pris : une instance tourne ailleurs."
    warn "Pour la METTRE A JOUR, placez-vous dans SON dossier (celui qui contient docker-compose.yml et ./data) puis relancez ./install.sh."
    warn "Pour un 2e deploiement separe ici : relancez avec --port <autre_port>."
  fi
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

# ── 2b) Mise à jour : SAUVEGARDE ./data, puis récupère la dernière version ─────
# La mise à jour (sélecteur ou --update) sauvegarde ./data AVANT toute migration, puis
# récupère le code (git) et reconstruit l'image ; ./data (config + DB + master.key) est
# préservé. En mode offline/bundle (pas de checkout git) le pull est ignoré.
LAST_BACKUP_TS=""      # horodatage de la sauvegarde de cette exécution (pour --rollback)
SERVICE_STOPPED=false  # vrai entre `docker compose stop` et le redémarrage effectif

# Repères de l'instance AVANT mise à jour : sans eux, revenir à « la version d'avant »
# est une devinette. IMAGE_ID permet un retour arrière instantané et hors-ligne
# (ré-étiquetage de l'image locale), GIT_REV le rebuild exact si elle a été élaguée.
record_backup_metadata() {
  local bk="$1" f
  git rev-parse HEAD > "$bk/GIT_REV" 2>/dev/null || true
  docker image inspect -f '{{.Id}}' "$IMAGE" > "$bk/IMAGE_ID" 2>/dev/null || true
  grep -E '^version' pyproject.toml 2>/dev/null | head -1 | cut -d'"' -f2 > "$bk/VERSION" 2>/dev/null || true
  # Un repère VIDE est pire qu'absent (il fait croire à une info connue) → on le retire.
  for f in GIT_REV IMAGE_ID VERSION; do [ -s "$bk/$f" ] || rm -f "$bk/$f"; done
}

backup_data() {
  [ -d data ] || return 0
  local ts bk; ts="$(date +%Y%m%d-%H%M%S)"; bk="backups/$ts"; mkdir -p "$bk"
  say "Sauvegarde de ./data avant mise à jour → $bk"
  cp -a data/master.key "$bk/" 2>/dev/null && chmod 600 "$bk/master.key" 2>/dev/null || true
  record_backup_metadata "$bk"
  if [ -n "$(docker compose ps -q postgres 2>/dev/null || true)" ] || grep -qiE '^ITSM_DATABASE_URL=.*postgres' .env 2>/dev/null; then
    local pu pd; pu="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | head -1 | cut -d= -f2-)"; pu="${pu:-itsm}"
    pd="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | head -1 | cut -d= -f2-)"; pd="${pd:-itsm}"
    if docker compose exec -T postgres pg_dump -U "$pu" "$pd" > "$bk/dump.sql" 2>/dev/null && [ -s "$bk/dump.sql" ]; then
      echo "  dump PostgreSQL OK → $bk/dump.sql"; check_add "Sauvegarde ./data" "ok:$bk"; LAST_BACKUP_TS="$ts"
    else
      rm -f "$bk/dump.sql"
      warn "pg_dump indisponible — AUCUNE sauvegarde de la base (instance arrêtée ?)."
      warn "  Aucun retour arrière ne sera possible sur la base. Interrompez (Ctrl-C) si ce n'est pas voulu."
      check_add "Sauvegarde ./data" "warn:DB NON sauvegardée"
    fi
  else
    # Copie SQLite À FROID : le moteur est arrêté, donc `itsm.db` + `-wal` forment un
    # ensemble cohérent (le `-wal` seul contient parfois des SEMAINES d'écritures non
    # checkpointées : le copier est OBLIGATOIRE). Si un Python est disponible on
    # préfère `VACUUM INTO`, qui produit UN fichier déjà consolidé et vérifiable.
    docker compose stop >/dev/null 2>&1 || true; SERVICE_STOPPED=true
    if [ ! -f data/itsm.db ]; then
      warn "Aucune base data/itsm.db à sauvegarder."; check_add "Sauvegarde ./data" "warn:pas de base"
      return 0
    fi
    local py=""; for c in .venv/bin/python python3 python; do command -v "$c" >/dev/null 2>&1 && { py="$c"; break; }; done
    local done_ok=false
    if [ -n "$py" ]; then
      if "$py" -c "
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
con = sqlite3.connect(src, timeout=30)
try:
    con.execute('VACUUM INTO ?', (dst,))
finally:
    con.close()
chk = sqlite3.connect(dst)
try:
    if chk.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        sys.exit('integrity_check KO')
finally:
    chk.close()
" data/itsm.db "$bk/itsm.db" 2>&1; then done_ok=true; fi
    fi
    if ! $done_ok; then
      cp -a data/itsm.db* "$bk/" 2>/dev/null && [ -f "$bk/itsm.db" ] && done_ok=true
    fi
    if $done_ok; then
      echo "  sauvegarde SQLite OK ($(du -h "$bk/itsm.db" | cut -f1))"
      check_add "Sauvegarde ./data" "ok:$bk"; LAST_BACKUP_TS="$ts"
    else
      warn "SAUVEGARDE SQLITE ÉCHOUÉE — mise à jour interrompue (aucun retour arrière possible)."
      check_add "Sauvegarde ./data" "fail:copie impossible"
      die "Impossible de sauvegarder data/itsm.db — rien n'a été modifié."
    fi
  fi
}

# Filet de sécurité de la mise à jour : `backup_data` ARRÊTE le conteneur, et tout ce qui
# suit (git, docker build) peut échouer. Sans ce trap, le script mourait en laissant
# l'instance À L'ARRÊT — panne totale, pour une mise à jour qui n'a même pas eu lieu.
# On redémarre alors l'ANCIENNE image (le build raté n'a rien retagué) et on rappelle
# la commande de retour arrière complet.
restore_service_on_failure() {
  local code=$?
  trap - EXIT
  [ "$code" -eq 0 ] && exit 0
  if [ "$SERVICE_STOPPED" = true ]; then
    warn "Mise à jour interrompue (code $code) — redémarrage de l'instance précédente…"
    if docker compose up -d >/dev/null 2>&1; then
      warn "Instance redémarrée sur la version PRÉCÉDENTE (aucune donnée perdue)."
    else
      warn "Redémarrage automatique impossible : lancez « docker compose up -d »."
    fi
  fi
  # Vaut aussi quand le moteur a démarré puis planté (migration incompatible…) :
  # revenir à l'image précédente SANS restaurer la base ne fait que déplacer la panne.
  [ -n "$LAST_BACKUP_TS" ] && warn "Retour arrière complet (base + clé + image) : ./install.sh --rollback $LAST_BACKUP_TS"
  exit "$code"
}

if [ "$SELF_UPDATE" = true ]; then
  trap restore_service_on_failure EXIT
  backup_data
  if [ -d .git ] && command -v git >/dev/null 2>&1; then
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
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
# (IMAGE est défini plus haut : --rollback en a besoin avant cette section.)
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
  # Un build raté ne retague RIEN : l'ancienne image reste utilisable, et le trap
  # `restore_service_on_failure` relance donc l'instance précédente au lieu de la
  # laisser à l'arrêt (c'était le trou : stop → build KO → die → service mort).
  docker build -t "$IMAGE" . || die "Image build failed (see output above)."
  say "Starting"
  # --force-recreate : remplace un conteneur perime/casse (p.ex. dont le dossier ./data
  # monte a ete supprime). Sans danger : les donnees vivent dans le volume ./data de l'hote.
  docker compose up -d --force-recreate || die "Start failed (see: docker compose logs)."
  SERVICE_STOPPED=false
  check_add "Image built" ok
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "Image $IMAGE absent. Provide --bundle or drop --no-build."
  say "Starting with image $IMAGE (no build)"
  docker compose up -d --force-recreate || die "Start failed (see: docker compose logs)."
  SERVICE_STOPPED=false
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
# Peut-on demander interactivement ? stdin = TTY direct, OU un /dev/tty utilisable même
# quand stdin est un pipe (cas du one-liner `curl … | sh`).
can_prompt() { [ -t 0 ] || { [ -r /dev/tty ] && [ -w /dev/tty ]; }; }
run_admin_setup() {  # "$@" → extra flags ; returns the setup exit code
  if [ -t 0 ]; then
    docker compose exec itsm python -m itsm_modern_ai.admin_setup "$@"
  elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
    # one-liner `curl … | sh` : stdin = pipe, mais le terminal reste accessible via /dev/tty
    docker compose exec itsm python -m itsm_modern_ai.admin_setup "$@" < /dev/tty
  elif [ -n "${ITSM_ADMIN_PASSWORD:-}" ]; then
    docker compose exec -T -e ITSM_ADMIN_PASSWORD itsm python -m itsm_modern_ai.admin_setup "$@"
  else
    die "Pas de terminal interactif et ITSM_ADMIN_PASSWORD non defini - mot de passe admin REQUIS."
  fi
}
if [ "$RESET" = true ]; then
  say "Resetting the administrator password (required)"; run_admin_setup --force || true
elif admin_is_set; then
  say "An administrator password is already configured — left unchanged."
fi
# Enforce: a password MUST be set. Interactive → retry until set (typo/too short).
if ! admin_is_set; then
  if can_prompt; then
    tries=0
    until admin_is_set; do
      tries=$((tries+1)); [ "$tries" -gt 5 ] && die "Mot de passe admin toujours non defini apres plusieurs tentatives."
      say "Definissez le mot de passe administrateur - REQUIS (min. 8 caracteres)"
      run_admin_setup || warn "Non defini (incoherence ou trop court) - reessayez."
    done
  else
    run_admin_setup || true
    admin_is_set || die "Impossible de definir le mot de passe admin depuis ITSM_ADMIN_PASSWORD (min. 8 caracteres)."
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
  # IP LAN de la machine (acces distant) ; localhost ne marche qu'en local.
  host_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  [ -n "$host_ip" ] || host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s== Installation reussie ==%s\n' "$c_grn" "$c_off"
  if [ -n "$host_ip" ]; then
    printf '   Console : %shttp://%s:%s%s\n' "$c_grn" "$host_ip" "$PORT" "$c_off"
    printf '             http://localhost:%s (sur cette machine)\n' "$PORT"
  else
    printf '   Console : %shttp://localhost:%s%s\n' "$c_grn" "$PORT" "$c_off"
  fi
  echo "   Configurez GLPI, le fournisseur LLM et le perimetre depuis la console web."
  echo "   Devenir Supporter : collez votre cle de licence dans la page Supporter."
  # Procedure de retour arriere annoncee AVANT d'en avoir besoin : a 2 h du matin, on ne
  # cherche pas la commande, on la relit dans le journal de la mise a jour.
  if [ -n "$LAST_BACKUP_TS" ]; then
    echo
    printf '%s== Retour arriere (si cette version pose probleme) ==%s\n' "$c_yel" "$c_off"
    printf '   ./install.sh --rollback %s\n' "$LAST_BACKUP_TS"
    echo "   (restaure la base + master.key + l'image d'avant, puis redemarre ;"
    echo "    l'etat actuel est conserve dans data/pre-rollback-<horodatage>)"
    echo "   Lister les sauvegardes : ./install.sh --list-backups"
  fi
else
  die "Certains controles ont echoue (voir ci-dessus)."
fi
