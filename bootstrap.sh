#!/bin/sh
# ITSM Modern AI — Community one-line bootstrap.
#
#   curl -fsSL https://itsm-modern-ai.com/install | sh
#   curl -fsSL https://itsm-modern-ai.com/install | sh -s -- --bundle itsm.tar.gz
#
# Fetches the Community repo and runs ./install.sh (which checks Docker/compose,
# offers to install missing parts, starts the service and prints a checklist).
#
# Env overrides:
#   ITSM_REPO_URL  git URL of the Community repo (default: internal GitLab)
#   ITSM_REF       branch/tag to install (default: master)
#   ITSM_DIR       target directory (default: itsm-modern-ai)
#
# NOTE: the repo must be reachable anonymously (public) — or set ITSM_REPO_URL with an
# embedded token for a private repo, e.g. https://oauth2:<TOKEN>@host/root/itsm-...git
set -eu

REPO_URL="${ITSM_REPO_URL:-https://gitlab.lab.wicaebeth.com/root/itsm-modern-ai-v2.git}"
REF="${ITSM_REF:-master}"
DIR="${ITSM_DIR:-itsm-modern-ai}"

say() { printf '\033[1;36m▶ %s\033[0m\n' "$1"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
pkg_install() {
  if   command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif command -v dnf     >/dev/null 2>&1; then $SUDO dnf install -y "$@"
  elif command -v yum     >/dev/null 2>&1; then $SUDO yum install -y "$@"
  elif command -v zypper  >/dev/null 2>&1; then $SUDO zypper --non-interactive install "$@"
  elif command -v pacman  >/dev/null 2>&1; then $SUDO pacman -S --noconfirm "$@"
  elif command -v apk     >/dev/null 2>&1; then $SUDO apk add "$@"
  else return 1; fi
}

command -v git >/dev/null 2>&1 || { say "Installing git"; pkg_install git || die "Please install git first."; }

MODE="install"
if [ -d "$DIR/.git" ]; then
  # Existing checkout → UPDATE. The pull + rebuild is delegated to `install.sh --update`
  # (single source of truth for the update logic). Data in ./data is preserved.
  say "Existing install found in '$DIR' → update"
  MODE="update"
else
  say "Cloning $REPO_URL (ref: $REF) into '$DIR'"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$DIR" \
    || die "Clone failed. Private repo? Set ITSM_REPO_URL with a token, or make the repo public."
fi

cd "$DIR"
if [ "$MODE" = "update" ]; then
  # `--update` fait un git pull ; incompatible avec une MAJ hors-ligne par bundle. Si
  # l'utilisateur a passé --bundle, on laisse install.sh gérer le bundle sans git pull.
  case " $* " in
    *" --bundle "*) say "Updating from offline bundle"; exec ./install.sh "$@" ;;
    *) say "Updating (./install.sh --update)"; exec ./install.sh --update "$@" ;;
  esac
else
  say "Launching the installer (./install.sh)"
  exec ./install.sh "$@"
fi
