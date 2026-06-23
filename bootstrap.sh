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
#   ITSM_REPO_URL  git URL of the Community repo (default: public GitHub)
#   ITSM_REF       branch/tag to install (default: main)
#   ITSM_DIR       target directory (default: itsm-modern-ai)
#
# NOTE: the repo must be reachable anonymously (public) — or set ITSM_REPO_URL with an
# embedded token for a private repo, e.g. https://oauth2:<TOKEN>@host/root/itsm-...git
set -eu

REPO_URL="${ITSM_REPO_URL:-https://github.com/WicaebethTheo/itsm-modern-ai.git}"
REF="${ITSM_REF:-main}"
DIR="${ITSM_DIR:-itsm-modern-ai}"

say() { printf '\033[1;36m▶ %s\033[0m\n' "$1"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
pkg_install() {
  if   command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif command -v dnf     >/dev/null 2>&1; then $SUDO dnf install -y "$@"
  elif command -v yum     >/dev/null 2>&1; then $SUDO yum install -y "$@"
  elif command -v zypper  >/dev/null 2>&1; then $SUDO zypper --non-interactive install "$@"
  elif command -v pacman  >/dev/null 2>&1; then $SUDO pacman -S --noconfirm "$@"
  elif command -v apk     >/dev/null 2>&1; then $SUDO apk add "$@"
  else return 1; fi
}

command -v git >/dev/null 2>&1 || { say "Installing git"; pkg_install git || die "Please install git first."; }

if [ -d "$DIR/.git" ]; then
  say "Dépôt déjà présent dans '$DIR' — lancement de l'installeur"
else
  say "Cloning $REPO_URL (ref: $REF) into '$DIR'"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$DIR" \
    || die "Clone failed. Private repo? Set ITSM_REPO_URL with a token, or make the repo public."
fi

cd "$DIR"
# install.sh est l'unique point d'entrée : il installe, ou — si une instance existe déjà
# dans ./data — propose un menu « Mettre à jour / Réinstaller » (sauvegarde ./data incluse).
exec ./install.sh "$@"
