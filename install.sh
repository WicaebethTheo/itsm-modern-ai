#!/usr/bin/env bash
# On-premise installer — COMMUNITY edition.
#
# Checks prerequisites (offers to install missing ones), prepares config, starts the
# service, creates the admin account, then prints a final CHECKLIST of system state.
#
# Une seule commande pour TOUT : installer ET mettre à jour. Si une instance existe
# déjà dans ce dossier, un menu propose « Mettre à jour » (sauvegarde base + clé incluse)
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
# Le retour arriere ECRASE la base : il exige une confirmation TAPEE (l'horodatage de la
# sauvegarde). `--yes` ne suffit pas et une absence de terminal ne vaut pas accord ; sans
# terminal, declarez-le : ITSM_ROLLBACK_CONFIRME=<horodatage> ./install.sh --rollback <horodatage>
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
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac; shift
done

# ── Output helpers ──────────────────────────────────────────────────────────
c_cyan=$'\033[1;36m'; c_red=$'\033[1;31m'; c_grn=$'\033[1;32m'; c_yel=$'\033[1;33m'; c_off=$'\033[0m'
say()  { printf '%s▶ %s%s\n' "$c_cyan" "$1" "$c_off"; }
warn() { printf '%s! %s%s\n' "$c_yel" "$1" "$c_off"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$1" "$c_off" >&2; exit 1; }
ask()  { # 0 = oui. --yes => oui ; TTY (stdin OU /dev/tty, ex. curl|sh) => demande (defaut OUI) ; sinon => oui (auto, CI).
  # ⚠️ COMPLAISANT PAR CONSTRUCTION, et ce n'est acceptable que pour des questions
  # REVERSIBLES (installer un prerequis, rebatir une image). Pour tout ce qui detruit des
  # donnees, utiliser `confirmer_ecrasement` : `ask` repond oui sur Entree, oui avec --yes
  # et oui tout seul hors TTY — trois facons d'ecraser une base sans qu'un humain ait rien
  # tape.
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

# Confirmation d'une operation DESTRUCTRICE (restauration : la base est ecrasee).
# Trois differences volontaires avec `ask`, chacune vaut pour une facon de perdre une base :
#   1. il faut TAPER le mot attendu — Entree ne vaut plus oui (« j'ai valide sans lire ») ;
#   2. `--yes` ne suffit PAS — ce drapeau vise les prerequis, pas la destruction de donnees ;
#   3. hors TTY, on N'INVENTE PAS de reponse : on s'arrete. La seule facon de restaurer sans
#      terminal est de le DECLARER, en nommant la sauvegarde visee :
#        ITSM_ROLLBACK_CONFIRME=<horodatage> ./install.sh --rollback <horodatage>
#      (impossible a declencher par accident, et tracable dans l'historique du shell).
confirmer_ecrasement() {
  local attendu="$1" question="$2" invite r=""
  if [ -n "${ITSM_ROLLBACK_CONFIRME:-}" ]; then
    if [ "$ITSM_ROLLBACK_CONFIRME" = "$attendu" ]; then
      warn "Ecrasement confirme par ITSM_ROLLBACK_CONFIRME=$attendu (mode non interactif)."
      return 0
    fi
    die "ITSM_ROLLBACK_CONFIRME=$ITSM_ROLLBACK_CONFIRME ne designe pas la sauvegarde $attendu — rien n'a ete modifie."
  fi
  invite="$(printf '%s? %s\n  Tapez %s pour confirmer (toute autre saisie annule) : %s' \
    "$c_yel" "$question" "$attendu" "$c_off")"
  if [ -t 0 ]; then
    read -r -p "$invite" r
  elif [ -r /dev/tty ] && [ -t 1 ]; then
    printf '%s' "$invite" > /dev/tty
    IFS= read -r r < /dev/tty || r=""
  else
    die "Aucun terminal pour confirmer une operation DESTRUCTRICE — rien n'a ete modifie.
   Pour restaurer sans terminal, declarez-le explicitement :
     ITSM_ROLLBACK_CONFIRME=$attendu ./install.sh --rollback $attendu"
  fi
  [ "$r" = "$attendu" ] || { say "Annule — aucune modification."; exit 0; }
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

# ── Garde de MAJEURE PostgreSQL ──────────────────────────────────────────────
# Le repertoire de donnees d'un cluster n'est PAS relisible par une autre majeure. Un
# `docker compose pull && up -d` apres un bump de tag (16 -> 17) donne, sur un
# ./data/postgres existant :
#     FATAL: database files are incompatible with server
#     DETAIL: The data directory was initialized by PostgreSQL version 16, ...
# … puis, avec `restart: unless-stopped`, une boucle de redemarrage : postgres n'atteint
# jamais `healthy`, `depends_on: service_healthy` empeche le moteur de demarrer, et la
# console disparait. Un FATAL de PostgreSQL dans `docker logs` n'est pas un diagnostic.
#
# C'EST ICI QUE LE GARDE PROTEGE REELLEMENT, et pas dans l'entrypoint du moteur : sous
# compose, le moteur n'est jamais demarre quand la base boucle (service_healthy), donc son
# entrypoint ne s'execute pas. L'installeur, lui, parle AVANT le `up -d`. (Un garde de
# repli existe tout de meme dans docker/entrypoint.sh pour les topologies ou le PGDATA est
# visible du moteur sans depends_on.)
#
# La majeure ATTENDUE est lue dans docker-compose.yml : une seule source de verite, donc
# aucune valeur a bumper ici le jour d'une montee de version.
majeure_postgres_du_compose() {
  sed -n 's/^[[:space:]]*image:[[:space:]]*postgres:\([0-9]\{1,2\}\).*/\1/p' \
    docker-compose.yml 2>/dev/null | head -1
}

majeure_du_pgdata() {
  # PG_VERSION est ecrit par initdb et contient la majeure du cluster (« 16 », « 17 »).
  [ -r data/postgres/PG_VERSION ] || return 1
  tr -dc '0-9.' < data/postgres/PG_VERSION | cut -d. -f1
}

verifier_majeure_postgres() {
  local presente attendue
  presente="$(majeure_du_pgdata)" || return 0     # pas de cluster local : rien a verifier
  attendue="$(majeure_postgres_du_compose)"
  [ -n "$presente" ] && [ -n "$attendue" ] || return 0
  [ "$presente" = "$attendue" ] && return 0
  die "BASE INCOMPATIBLE : ./data/postgres a ete initialise par PostgreSQL $presente, mais la
   stack demande PostgreSQL $attendue. Les fichiers d'un cluster ne se relisent PAS d'une
   majeure a l'autre : demarrer ainsi donnerait « database files are incompatible with
   server », une boucle de redemarrage et une console injoignable. Rien n'a ete modifie.

   Migration (moteur a l'arret, ~5 min, la base reste lisible par SON image d'origine) :
     docker compose stop itsm
     docker run -d --name itsm-pg-avant \\
       -v \"\$PWD/data/postgres:/var/lib/postgresql/data\" postgres:$presente-alpine
     docker exec itsm-pg-avant pg_dump -U itsm -Fc itsm > avant-bump.dump
     docker rm -f itsm-pg-avant                       # dump pris par l'ANCIENNE majeure
     mv data/postgres data/postgres.pg$presente.bak   # on GARDE l'ancien cluster
   (jamais \`docker exec -t\` pour un dump : le pseudo-terminal corrompt le binaire.)
     docker compose up -d postgres                    # nouveau cluster, vide
     docker compose exec -T postgres pg_restore -U itsm -d itsm --no-owner < avant-bump.dump
     docker compose up -d itsm
   Verifiez la console AVANT de supprimer data/postgres.pg$presente.bak.

   (Repartir de l'image d'origine est aussi valable : remettre postgres:$presente-alpine
   dans docker-compose.yml redonne une stack qui demarre, sans rien migrer.)"
}

# ── Base PostgreSQL : identifiants + disponibilite ───────────────────────────
# Memes variables que celles lues par le compose (cf. .env.example) : on parle a la base
# avec le role qui la possede. Defauts alignes sur ceux du compose.
pg_user() { local v; v="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | head -1 | cut -d= -f2-)"; echo "${v:-itsm}"; }
pg_db()   { local v; v="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | head -1 | cut -d= -f2-)"; echo "${v:-itsm}"; }

# Demarre la base SEULE (sans le moteur) et attend qu'elle accepte les connexions.
# `up -d postgres` est non destructif et sans effet si elle tourne deja : c'est ce qui
# permet de sauvegarder ET de restaurer meme quand le moteur est a l'arret — un dump ne
# peut pas etre pris sur un serveur eteint, contrairement a l'ancien fichier SQLite.
# Attente BORNEE (~60 s) : au-dela, on rend la main a l'appelant qui decide (die).
pg_ready() {
  local u d i
  u="$(pg_user)"; d="$(pg_db)"
  docker compose up -d postgres >/dev/null 2>&1
  for i in $(seq 1 30); do
    docker compose exec -T postgres pg_isready -U "$u" -d "$d" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Dump VERIFIE de la base vers "$1". Le dump est pris au format `custom` (celui que
# produit et relit `python -m itsm_modern_ai.backup`), puis RELU par `pg_restore --list` :
# un fichier tronque ou vide est ainsi refuse ici, pas le jour de la restauration.
pg_dump_verifie() {
  local cible="$1" u d
  u="$(pg_user)"; d="$(pg_db)"
  docker compose exec -T postgres pg_dump -U "$u" -d "$d" --format=custom > "$cible" 2>/dev/null || return 1
  [ -s "$cible" ] || return 1
  docker compose exec -T postgres pg_restore --list < "$cible" 2>/dev/null | grep -q 'TABLE DATA' || return 1
  return 0
}

show_backups() {
  local ts n
  n=0
  printf '%s▶ Sauvegardes disponibles (dossier ./backups)%s\n' "$c_cyan" "$c_off"
  for ts in $(backups_list); do
    [ -d "backups/$ts" ] || continue
    n=$((n+1))
    printf '   %s' "$ts"
    [ -f "backups/$ts/itsm.dump" ] && printf '  dump PostgreSQL (%s)' "$(du -h "backups/$ts/itsm.dump" | cut -f1)"
    # Format SQL brut : produit par les versions anterieures de ce script. Toujours
    # restaurable (via psql), donc toujours liste.
    [ -f "backups/$ts/dump.sql" ] && printf '  dump PostgreSQL SQL (%s)' "$(du -h "backups/$ts/dump.sql" | cut -f1)"
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
  local ts="$1" bk safe img rev u d
  [ -n "$ts" ] || ts="$(latest_backup)"
  [ -n "$ts" ] || { show_backups; die "Aucune sauvegarde à restaurer."; }
  bk="backups/$ts"
  [ -d "$bk" ] || { show_backups; die "Sauvegarde introuvable : $bk"; }
  if [ ! -f "$bk/itsm.dump" ] && [ ! -f "$bk/dump.sql" ]; then
    die "$bk ne contient aucune base ($bk/itsm.dump) — restauration impossible."
  fi
  u="$(pg_user)"; d="$(pg_db)"
  say "Retour arrière vers la sauvegarde $ts"
  # Confirmation EXPLICITE : la restauration est destructive (le schéma actuel de la base
  # « $d » est SUPPRIMÉ puis rebâti depuis l'archive). L'état courant est dumpé juste avant
  # dans data/pre-rollback-<horodatage> — donc réversible, mais on ne le fait pas en
  # silence, et surtout pas sur une simple touche Entrée (cf. `confirmer_ecrasement`).
  confirmer_ecrasement "$ts" \
    "La base « $d » va être ÉCRASÉE par la sauvegarde $ts (son état actuel est dumpé avant)."

  # Port publié CONSERVÉ : sans cela, une instance installée avec --port 8080
  # ressusciterait sur 8000 après un rollback (console « disparue » pour les clients).
  local hp; hp="$(docker inspect --format \
    '{{range $c := .HostConfig.PortBindings}}{{(index $c 0).HostPort}}{{end}}' \
    itsm-modern-ai 2>/dev/null | head -1)"
  [ -n "$hp" ] && PORT="$hp"
  export ITSM_HOST_PORT="$PORT"
  say "Port publié conservé : $PORT"

  # 1) Seul le MOTEUR est arrêté : la base doit rester en marche pour être restaurée
  # (JAMAIS `down -v` : cela détruirait le volume de données).
  docker compose stop itsm >/dev/null 2>&1
  pg_ready || die "Base PostgreSQL injoignable — restauration impossible (docker compose logs postgres)."

  # 2) L'état courant est DUMPÉ avant d'être écrasé : un rollback raté reste réversible.
  # Un dump impossible n'est PAS une question à poser : sans lui, la remise à plat de
  # l'étape 3 devient un aller simple. On refuse, on ne demande pas — l'exploitant garde
  # une base intacte et peut réparer l'accès (docker compose logs postgres) avant de
  # relancer. (Poser la question ici était doublement piégeux : hors TTY, l'ancienne
  # `ask` répondait oui toute seule et écrasait la base sans une seule invite.)
  safe="data/pre-rollback-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$safe"
  if pg_dump_verifie "$safe/itsm.dump"; then
    say "État actuel de la base dumpé dans $safe/itsm.dump (à supprimer une fois le rollback validé)"
  else
    rm -f "$safe/itsm.dump"; rmdir "$safe" 2>/dev/null || true
    die "Impossible de dumper l'état ACTUEL de la base — restauration REFUSÉE (elle serait irréversible).
   Rien n'a été modifié. Vérifiez la base (docker compose logs postgres) puis relancez.
   L'instance est repartie ? relancez simplement : docker compose up -d"
  fi
  # La clé courante est COPIÉE (et non déplacée) à côté du dump de sécurité : elle reste en
  # place tant que la restauration n'a pas abouti. Un `mv` laissait une fenêtre où
  # data/master.key manquait — si la suite échouait, l'instance redémarrait sans sa clé et
  # se heurtait au garde-fou `MasterKeyLostError`, pour un rollback qui n'avait même pas eu
  # lieu. Elle sera écrasée par celle de la sauvegarde à l'étape suivante.
  if [ -f "$bk/master.key" ] && [ -f data/master.key ]; then
    cp -a data/master.key "$safe/" && chmod 600 "$safe/master.key" 2>/dev/null || true
  fi

  # 3) SCHÉMA REMIS À PLAT, puis restauration. C'est le point le plus contre-intuitif du
  # retour arrière PostgreSQL, et celui qui l'a rendu faux : `pg_restore --clean` ne
  # supprime QUE les objets présents DANS L'ARCHIVE. Une table créée par une migration
  # POSTÉRIEURE à la sauvegarde (p. ex. `technician_absences`) survit donc à la
  # restauration, pendant qu'`alembic_version` est rembobiné. Le rollback rend 0, et c'est
  # la mise à jour SUIVANTE qui meurt :
  #     psycopg.errors.DuplicateTable: relation "technician_absences" already exists
  # … dans un entrypoint en `set -euo pipefail`, donc en boucle de redémarrage, console
  # inaccessible. L'ère SQLite ne pouvait pas avoir ce défaut : elle remplaçait le FICHIER
  # entier. On reproduit cette propriété — un schéma vide, puis l'archive — ce qui rend la
  # restauration idempotente et indépendante de l'écart de révisions.
  # L'ordre compte : la remise à plat n'a lieu qu'APRÈS un dump de sécurité VÉRIFIÉ (2).
  say "Remise à plat du schéma « public » (l'état d'avant est dans $safe/itsm.dump)"
  docker compose exec -T postgres psql -U "$u" -d "$d" -v ON_ERROR_STOP=1 -q \
    -c 'DROP SCHEMA IF EXISTS public CASCADE' -c 'CREATE SCHEMA public' \
    || die "Remise à plat du schéma échouée — base INCHANGÉE, rien n'a été restauré."

  # Base + clé de chiffrement restaurées ENSEMBLE (une base sans sa clé est illisible).
  # Plus de `--clean --if-exists` : il n'a plus rien à nettoyer (le schéma vient d'être
  # recréé vide) et c'est précisément lui qui donnait l'illusion d'une base remise à
  # l'identique. `--exit-on-error` : une restauration à moitié faite est pire qu'une
  # restauration refusée — on s'arrête à la première erreur, l'état d'avant est dans $safe.
  if [ -f "$bk/itsm.dump" ]; then
    docker compose exec -T postgres pg_restore -U "$u" -d "$d" \
      --no-owner --exit-on-error < "$bk/itsm.dump" \
      || die "Restauration échouée — base dans un état intermédiaire. Reprise : pg_restore ... < $safe/itsm.dump"
    echo "  base PostgreSQL restaurée depuis $bk/itsm.dump"
  else
    # Format SQL brut produit par les versions antérieures de ce script. `ON_ERROR_STOP=1`
    # pour la même raison que `--exit-on-error` ci-dessus (psql ignore les erreurs sinon).
    docker compose exec -T postgres psql -U "$u" -d "$d" -v ON_ERROR_STOP=1 < "$bk/dump.sql" >/dev/null \
      || die "Restauration échouée — base dans un état intermédiaire. Reprise : pg_restore ... < $safe/itsm.dump"
    echo "  base PostgreSQL restaurée depuis $bk/dump.sql (format SQL)"
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

# Garde de MAJEURE : AVANT tout `docker compose up`, y compris celui que `pg_ready`
# déclenche pour sauvegarder ou restaurer. Un cluster d'une autre majeure ne démarrera pas,
# et l'exploitant doit lire la procédure, pas un crash-loop (cf. verifier_majeure_postgres).
verifier_majeure_postgres
check_add "Majeure PostgreSQL du cluster" ok

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

# ── 2b) Mise à jour : SAUVEGARDE la base, puis récupère la dernière version ────
# La mise à jour (sélecteur ou --update) dumpe la base + copie la master.key AVANT toute
# migration, puis récupère le code (git) et reconstruit l'image ; le volume (cluster
# PostgreSQL + master.key) est préservé. En mode offline/bundle (pas de checkout git) le
# pull est ignoré.
LAST_BACKUP_TS=""      # horodatage de la sauvegarde de cette exécution (pour --rollback)

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

# Sauvegarde AVANT toute migration. BLOQUANTE : sans elle, `--rollback` n'a rien à
# restaurer et une migration qui se passe mal devient un aller simple. Un `warn` ne
# suffirait pas — l'exploitant ne lit les avertissements qu'après coup.
# Le dump est pris À CHAUD (pg_dump travaille sur un instantané transactionnel cohérent) :
# inutile d'arrêter le moteur, donc pas d'interruption de service pour la sauvegarde.
backup_data() {
  [ -d data ] || return 0
  local ts bk; ts="$(date +%Y%m%d-%H%M%S)"; bk="backups/$ts"; mkdir -p "$bk"
  say "Sauvegarde avant mise à jour → $bk"
  cp -a data/master.key "$bk/" 2>/dev/null && chmod 600 "$bk/master.key" 2>/dev/null || true
  record_backup_metadata "$bk"
  # `pg_ready` démarre la base au besoin : une instance à l'arrêt reste sauvegardable
  # (contrairement à un serveur éteint, dont on ne peut rien dumper).
  if ! pg_ready; then
    check_add "Sauvegarde ./data" "fail:base injoignable"
    die "Base PostgreSQL injoignable — sauvegarde impossible, rien n'a été modifié (docker compose logs postgres)."
  fi
  if pg_dump_verifie "$bk/itsm.dump"; then
    echo "  dump PostgreSQL vérifié → $bk/itsm.dump ($(du -h "$bk/itsm.dump" | cut -f1))"
    check_add "Sauvegarde ./data" "ok:$bk"; LAST_BACKUP_TS="$ts"
  else
    rm -f "$bk/itsm.dump"
    check_add "Sauvegarde ./data" "fail:pg_dump KO"
    die "Sauvegarde de la base ÉCHOUÉE (pg_dump) — mise à jour interrompue, rien n'a été modifié."
  fi
}

# Filet de sécurité de la mise à jour : tout ce qui suit la sauvegarde (git, docker build,
# `up -d --force-recreate`) peut échouer, et un `--force-recreate` interrompu laisse le
# conteneur À L'ARRÊT — panne totale, pour une mise à jour qui n'a même pas eu lieu.
# On tente donc TOUJOURS un redémarrage (`up -d` est idempotent : sans effet si l'instance
# tourne déjà, et il repart sur l'ANCIENNE image puisqu'un build raté n'a rien retagué),
# puis on rappelle la commande de retour arrière complet.
restore_service_on_failure() {
  local code=$?
  trap - EXIT
  [ "$code" -eq 0 ] && exit 0
  warn "Mise à jour interrompue (code $code) — redémarrage de l'instance précédente…"
  if docker compose up -d >/dev/null 2>&1; then
    warn "Instance redémarrée sur la version PRÉCÉDENTE (aucune donnée perdue)."
  else
    warn "Redémarrage automatique impossible : lancez « docker compose up -d »."
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
  check_add "Image built" ok
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "Image $IMAGE absent. Provide --bundle or drop --no-build."
  say "Starting with image $IMAGE (no build)"
  docker compose up -d --force-recreate || die "Start failed (see: docker compose logs)."
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
