#!/bin/sh
# ITSM Modern AI — bootstrap « depuis les sources ».
#
# Clone le dépôt puis lance ./install.sh (vérifie Docker/compose, propose d'installer
# ce qui manque, démarre le service et affiche une checklist). Voie pour qui veut
# construire localement (air-gap, `--bundle`, contributions).
#
# NB : le one-liner grand public `curl -fsSL https://itsm-modern-ai.com/install | bash`
# ne passe PAS par ce script — il sert l'installeur image (GHCR, sans clone ni build).
#
#   sh bootstrap.sh
#   sh bootstrap.sh --bundle itsm.tar.gz
#
# Variables d'environnement :
#   ITSM_REPO_URL  URL git du dépôt (défaut : GitHub public)
#   ITSM_REF       branche/tag à installer (défaut : main)
#   ITSM_DIR       répertoire cible (défaut : itsm-modern-ai)
#
# NOTE : le dépôt doit être accessible anonymement (public) — sinon, mettre un token
# dans ITSM_REPO_URL, ex. https://oauth2:<TOKEN>@gitlab.example.com/<group>/itsm-...git
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

# git (clone) ET bash (install.sh est un script bash) requis : on installe ce qui manque.
for _bin in git bash; do
  command -v "$_bin" >/dev/null 2>&1 || { say "Installing $_bin"; pkg_install "$_bin" || die "Please install $_bin first."; }
done

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
