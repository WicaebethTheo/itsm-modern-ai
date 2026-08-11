"""Sauvegarde à chaud de la base PostgreSQL + la clé de chiffrement.

POURQUOI CE MODULE EXISTE. La logique de sauvegarde ne vivait que dans le `Makefile` — donc
uniquement pour qui a cloné les sources. Or la voie de déploiement RECOMMANDÉE est
*pull-only* (image GHCR, Portainer, `docker run`, one-liner) : un exploitant qui suit la
documentation n'avait **aucun moyen de sauvegarder**. Sur un produit auto-hébergé dont la
base contient les données RGPD et dont le volume porte la `master.key` sans laquelle cette
base est définitivement illisible, c'était le trou le plus sérieux du déploiement.

    docker compose exec itsm python -m itsm_modern_ai.backup

C'est pour cette commande — et pour elle seule — que l'image embarque `postgresql-client`
(cf. Dockerfile). Sans `pg_dump` dans l'image, le déploiement pull-only redeviendrait
exactement ce qu'il était avant 0.9.56 : sans sauvegarde.

POURQUOI PAS UN `cp -a data/postgres`. Copier le PGDATA d'un serveur EN MARCHE produit un
cluster incohérent (fichiers de données et WAL capturés à des instants différents) : la
copie paraît réussir et se révèle irrécupérable le jour de la restauration. `pg_dump`
travaille dans une transaction à snapshot isolé : il produit un instantané cohérent SANS
arrêter le service.

CE QUI EST VÉRIFIÉ, ET POURQUOI DEUX CONTRÔLES. Une sauvegarde à laquelle on ferait
aveuglément confiance ne vaut rien : on ne découvre le problème que le jour où l'on
restaure. On reprend donc ici les DEUX garanties de l'ère SQLite (`integrity_check` +
comptage réel), transposées à PostgreSQL :

1. **STRUCTURE** — `pg_restore --list` relit l'en-tête et la table des matières de
   l'archive. Équivalent de `integrity_check` : une archive tronquée ou corrompue est
   refusée ici. On exige en plus une entrée `TABLE DATA` pour CHAQUE table de la base :
   une table oubliée par le dump ne passera pas inaperçue.
2. **CONTENU** — `pg_restore --data-only` relit et DÉCOMPRESSE l'intégralité des blocs de
   données, et l'on recompte les lignes table par table. Le point 1 seul validerait une
   archive structurellement saine mais VIDE (exactement ce que `integrity_check` laissait
   passer côté SQLite) ; et seule une relecture complète prouve que chaque octet écrit est
   relisible.

Tout échec est BRUYANT (code de sortie ≠ 0, dossier incomplet supprimé).
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, urlencode

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from .config.settings import get_settings

NOM_ARCHIVE = "itsm.dump"

# `COPY public.decisions (id, ...) FROM stdin;` — début d'un bloc de données dans la sortie
# de `pg_restore --data-only`. Le bloc se termine par une ligne `\.` ; en format texte, une
# ligne de COPY = une ligne de table (les retours chariot internes sont échappés `\n`).
# Le schéma `public` est EXIGÉ : c'est celui du moteur (et celui que compte
# `compte_les_lignes`). Sans cette contrainte, les tables d'un autre schéma présent dans la
# même base gonfleraient le total et masqueraient une table applicative vide.
_COPY = re.compile(r'^COPY\s+public\."?([^"\s(]+)"?\s*\(')


class BackupError(Exception):
    """Erreur fonctionnelle de sauvegarde (message clair, pas de stack)."""


def connexion_libpq(database_url: str) -> tuple[list[str], dict[str, str]]:
    """Traduit l'URL SQLAlchemy en arguments + environnement pour les outils `pg_*`.

    Le mot de passe passe par `PGPASSWORD` et JAMAIS par la ligne de commande : `ps` est
    lisible par tout le monde dans le conteneur, et un `-d "postgresql://user:pwd@..."`
    l'y exposerait. Le reste de l'URL (hôte, port, base, `?sslmode=…`) est conservé tel
    quel — un déploiement qui parle à un PostgreSQL externe en TLS doit continuer à
    fonctionner.
    """
    url = make_url(database_url)
    if not url.get_backend_name().startswith("postgresql"):
        raise BackupError(
            f"URL de base non supportée : {url.get_backend_name()!r}. "
            "PostgreSQL est la seule base supportée (postgresql+psycopg://…)."
        )
    env = dict(os.environ)
    if url.password:
        env["PGPASSWORD"] = url.password
    # DSN reconstruit à la main, SANS le mot de passe. `URL.set(password=None)` ne le
    # retirerait pas (SQLAlchemy interprète `None` comme « ne change rien ») et le secret
    # se retrouverait dans la ligne de commande.
    hote = url.host or "localhost"
    if ":" in hote:  # IPv6 littérale
        hote = f"[{hote}]"
    dsn = f"postgresql://{quote(url.username or '', safe='')}@{hote}:{url.port or 5432}/"
    dsn += quote(url.database or "", safe="")
    options = urlencode({k: v for k, v in url.query.items() if isinstance(v, str)})
    if options:
        dsn += f"?{options}"
    # `-w` : jamais d'invite de mot de passe interactive — cette CLI tourne dans un
    # `docker compose exec` non interactif, une invite y ferait pendre la sauvegarde.
    return ["-w", "-d", dsn], env


def _execute(argv: list[str], env: dict[str, str]) -> str:
    """Lance un outil `pg_*` et renvoie sa sortie standard, ou lève un `BackupError`."""
    try:
        proc = subprocess.run(argv, env=env, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise BackupError(
            f"{argv[0]} introuvable : le client PostgreSQL n'est pas installé.\n"
            "  Dans l'image livrée il l'est (paquet postgresql-client) ; depuis les sources, "
            "installez-le (Debian/Ubuntu : apt install postgresql-client)."
        ) from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        raise BackupError(
            f"{argv[0]} a échoué (code {proc.returncode}) : " + " / ".join(detail[-3:] or ["(aucun message)"])
        )
    return proc.stdout


def compte_les_lignes(database_url: str) -> dict[str, int]:
    """Compte les lignes de chaque table du schéma `public`, base EN MARCHE.

    C'est la RÉFÉRENCE à laquelle l'archive sera comparée : sans elle, on ne saurait pas
    distinguer « la base est vide » de « le dump n'a rien embarqué ».
    """
    moteur = create_engine(database_url, pool_pre_ping=True)
    try:
        with moteur.connect() as conn:
            tables = [
                r[0]
                for r in conn.execute(
                    text("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
                )
            ]
            comptes = {}
            for table in tables:
                # Identifiant venant du catalogue, jamais d'une saisie utilisateur — on
                # l'échappe quand même (guillemets doublés) plutôt que de concaténer du SQL brut.
                citee = '"' + table.replace('"', '""') + '"'
                comptes[table] = conn.execute(text(f"SELECT count(*) FROM public.{citee}")).scalar_one()
            return comptes
    except Exception as exc:  # noqa: BLE001 — message clair plutôt qu'une stack
        raise BackupError(
            f"Base injoignable ou illisible ({type(exc).__name__}: {exc}) — rien à sauvegarder."
        ) from exc
    finally:
        moteur.dispose()


def dump(args_connexion: list[str], env: dict[str, str], cible: Path) -> None:
    """`pg_dump` au format `custom` : compressé, restaurable table par table, et VÉRIFIABLE.

    Le format `custom` est retenu contre le SQL brut précisément parce qu'il est relisible
    par `pg_restore` : c'est ce qui rend la vérification ci-dessous possible sans serveur.
    """
    _execute(["pg_dump", *args_connexion, "--format=custom", "--file", str(cible)], env)


def _tables_de_l_archive(archive: Path, env: dict[str, str]) -> set[str]:
    """Contrôle n°1 (structure) : en-tête + table des matières relus par `pg_restore`."""
    sortie = _execute(["pg_restore", "--list", str(archive)], env)
    tables = set()
    for ligne in sortie.splitlines():
        if ligne.startswith(";"):
            continue
        # `3482; 0 16393 TABLE DATA public alembic_version itsm`
        marque = " TABLE DATA public "
        if marque in ligne:
            tables.add(ligne.split(marque, 1)[1].split()[0])
    return tables


def _lignes_de_l_archive(archive: Path, env: dict[str, str]) -> dict[str, int]:
    """Contrôle n°2 (contenu) : relit et décompresse TOUS les blocs de données.

    On lit en flux (`Popen`) : le dump d'une instance chargée ne tient pas forcément en
    mémoire, et il n'y a aucune raison de le matérialiser pour en compter les lignes.
    """
    proc = subprocess.Popen(
        ["pg_restore", "--data-only", "-f", "-", str(archive)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    lignes: dict[str, int] = {}
    table: str | None = None
    assert proc.stdout is not None
    for ligne in proc.stdout:
        if table is None:
            trouve = _COPY.match(ligne)
            if trouve:
                table = trouve.group(1)
                lignes.setdefault(table, 0)
        elif ligne.startswith("\\."):
            table = None
        else:
            lignes[table] += 1
    proc.stdout.close()
    erreur = (proc.stderr.read() if proc.stderr else "").strip()
    if proc.stderr:
        proc.stderr.close()
    if proc.wait() != 0:
        raise BackupError(f"relecture de l'archive impossible (pg_restore) : {erreur or '(aucun message)'}")
    return lignes


def verifie(archive: Path, attendu: dict[str, int], env: dict[str, str] | None = None) -> tuple[int, int]:
    """Vérifie l'archive contre le comptage fait sur la base vive. Renvoie `(tables, lignes)`.

    Refuse : une archive vide, une table absente de l'archive, une table qui avait des
    lignes et n'en a plus dans l'archive.
    """
    env = dict(os.environ) if env is None else env
    if not archive.exists() or archive.stat().st_size == 0:
        raise BackupError("archive absente ou VIDE — sauvegarde refusée")

    tables = _tables_de_l_archive(archive, env)
    if not tables:
        raise BackupError("archive sans aucune table — sauvegarde refusée")
    manquantes = sorted(set(attendu) - tables)
    if manquantes:
        raise BackupError(
            "table(s) présente(s) en base mais ABSENTE(S) de l'archive : " + ", ".join(manquantes)
        )

    relues = _lignes_de_l_archive(archive, env)
    vidées = sorted(t for t, n in attendu.items() if n > 0 and relues.get(t, 0) == 0)
    if vidées:
        raise BackupError(
            "table(s) VIDE(S) dans l'archive alors que la base en contient : " + ", ".join(vidées)
        )
    return len(tables), sum(relues.values())


def run(destination: Path, *, database_url: str, master_key_file: Path | None) -> Path:
    """Produit un dossier horodaté `destination/AAAAMMJJ-HHMMSS/`. Renvoie son chemin.

    Le dossier est SUPPRIMÉ si la vérification échoue : mieux vaut aucune sauvegarde qu'une
    sauvegarde à laquelle on ferait confiance à tort.
    """
    args_connexion, env = connexion_libpq(database_url)
    attendu = compte_les_lignes(database_url)

    horodatage = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    dossier = destination / horodatage
    dossier.mkdir(parents=True, exist_ok=False)
    try:
        archive = dossier / NOM_ARCHIVE
        dump(args_connexion, env, archive)
        tables, lignes = verifie(archive, attendu, env)
        taille = archive.stat().st_size / 1048576.0
        print(f"✓ {archive}  ({taille:.2f} Mio, {tables} tables, {lignes} lignes, archive relue intégralement)")
        # La base est VIVE pendant le dump : un écart de quelques lignes est normal (le
        # snapshot de pg_dump est postérieur au comptage). On l'affiche quand même — un
        # écart massif est le signe qu'on ne sauvegarde pas ce qu'on croit.
        attendues = sum(attendu.values())
        if lignes != attendues:
            print(f"  (comptage avant dump : {attendues} lignes — un écart est normal "
                  "si le moteur écrit pendant la sauvegarde)")

        # ⚠️ La master.key est INDISPENSABLE : sans elle, la base restaurée est illisible
        # (mot de passe admin, tokens GLPI et clé LLM sont chiffrés avec). La sauvegarder
        # séparément — ou l'oublier — revient à ne pas avoir de sauvegarde du tout.
        if master_key_file and master_key_file.exists():
            copie_cle = dossier / "master.key"
            shutil.copy2(master_key_file, copie_cle)
            copie_cle.chmod(0o600)
            print(f"✓ {copie_cle}  (clé de chiffrement — sans elle, la base est illisible)")
        else:
            print(
                "! master.key absente du volume : la clé vient donc de l'environnement "
                "(MASTER_KEY). SAUVEGARDEZ-LA AUSSI, séparément — sans elle, cette copie "
                "est inexploitable."
            )
    except Exception:
        shutil.rmtree(dossier, ignore_errors=True)
        raise
    return dossier


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m itsm_modern_ai.backup",
        description="Sauvegarde à chaud, cohérente et VÉRIFIÉE, de la base PostgreSQL + master.key.",
    )
    parser.add_argument(
        "--dest", default="data/backups",
        help="Dossier de destination (défaut : data/backups, donc DANS le volume).",
    )
    args = parser.parse_args(argv)
    settings = get_settings()
    try:
        dossier = run(
            Path(args.dest),
            database_url=settings.database_url,
            master_key_file=Path("data/master.key"),
        )
    except BackupError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 — message clair plutôt qu'une stack
        print(f"✗ SAUVEGARDE ÉCHOUÉE : {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"\n✓ Sauvegarde → {dossier}")
    print("\nRestauration (le moteur doit être ARRÊTÉ, la base reste en marche) :")
    print("  docker compose stop itsm")
    # ⚠️ Le schéma est REMIS À PLAT avant de restaurer, et surtout PAS restauré avec
    # `pg_restore --clean` : `--clean` ne supprime que les objets présents DANS l'archive.
    # Une table créée par une migration POSTÉRIEURE à cette sauvegarde survivrait donc,
    # pendant qu'`alembic_version` serait rembobiné — la restauration paraîtrait réussir et
    # c'est la mise à jour suivante qui mourrait sur « relation ... already exists »,
    # entrypoint en `set -e`, donc en boucle de redémarrage.
    print("  docker compose exec -T postgres psql -U itsm -d itsm -v ON_ERROR_STOP=1 \\")
    print("      -c 'DROP SCHEMA IF EXISTS public CASCADE' -c 'CREATE SCHEMA public'")
    print("  docker compose exec -T postgres pg_restore -U itsm -d itsm \\")
    print(f"      --no-owner --exit-on-error < {dossier}/{NOM_ARCHIVE}")
    print(f"  # puis, si présente : cp -a {dossier}/master.key data/master.key")
    print("  docker compose up -d itsm")
    print("  # Volume nommé (Portainer, sans accès au fichier depuis l'hôte) :")
    print(f"  #   docker compose exec -T itsm cat /app/{dossier}/{NOM_ARCHIVE} \\")
    print("  #     | docker compose exec -T postgres pg_restore -U itsm -d itsm --no-owner")
    print("  # (la remise à plat du schéma ci-dessus reste nécessaire dans ce cas aussi)")
    print("\n⚠️ La sauvegarde vit DANS le volume : copiez-la HORS de l'hôte "
          "(un volume perdu emporte ses sauvegardes).")
    return 0


if __name__ == "__main__":  # pragma: no cover — point d'entrée CLI
    raise SystemExit(main())
