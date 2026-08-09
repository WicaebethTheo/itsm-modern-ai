"""Sauvegarde à chaud de la base SQLite + la clé de chiffrement.

POURQUOI CE MODULE EXISTE. La logique de sauvegarde ne vivait que dans le `Makefile` — donc
uniquement pour qui a cloné les sources. Or la voie de déploiement RECOMMANDÉE est
*pull-only* (image GHCR, Portainer, `docker run`, one-liner) : un exploitant qui suit la
documentation n'avait **aucun moyen de sauvegarder**. Sur un produit auto-hébergé dont le
volume contient à la fois les données RGPD et la `master.key` sans laquelle la base est
définitivement illisible, c'était le trou le plus sérieux du déploiement.

    docker compose exec itsm python -m itsm_modern_ai.backup

POURQUOI PAS UN `cp data/itsm.db`. Le moteur tourne en `journal_mode=WAL`
(`persistence/db.py`). Tant que le WAL n'est pas checkpointé, les écritures récentes vivent
dans `itsm.db-wal` (plusieurs Mo en régime, soit des SEMAINES de journal) et le fichier
principal peut être quasi VIDE. Copier le seul `.db` produit une sauvegarde **muette** :
elle paraît réussir, et se révèle inutilisable à la restauration (« no such table: … »).

On utilise donc `VACUUM INTO` (repli : l'API `.backup` pour les SQLite < 3.27) : un SEUL
fichier, cohérent, WAL inclus, sans arrêter le service. La copie est ensuite VÉRIFIÉE —
`PRAGMA integrity_check` **et** comptage réel des tables et des lignes. Tout échec est
BRUYANT (code de sortie ≠ 0, dossier incomplet supprimé) : une sauvegarde qui ment est pire
que pas de sauvegarde, puisqu'on ne découvre le problème que le jour où l'on restaure.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from .config.settings import get_settings


class BackupError(Exception):
    """Erreur fonctionnelle de sauvegarde (message clair, pas de stack)."""


def sqlite_path(database_url: str) -> Path:
    """Chemin du fichier SQLite depuis l'URL SQLAlchemy, ou erreur si ce n'est pas SQLite."""
    if not database_url.startswith("sqlite"):
        raise BackupError(
            "Base non-SQLite détectée : cette commande ne sauvegarde que SQLite.\n"
            "  PostgreSQL → pg_dump, par exemple :\n"
            "  docker compose exec -T postgres pg_dump -U itsm itsm > dump.sql"
        )
    brut = database_url.split("///", 1)[-1]
    return Path(brut.split("?", 1)[0])


def copie_coherente(source: Path, cible: Path) -> None:
    """Copie à chaud, WAL inclus. `VACUUM INTO`, repli sur l'API `.backup`."""
    con = sqlite3.connect(str(source), timeout=30)
    try:
        con.execute("PRAGMA busy_timeout=30000")
        try:
            con.execute("VACUUM INTO ?", (str(cible),))
        except sqlite3.OperationalError as exc:
            # SQLite < 3.27 ne connaît pas VACUUM INTO : on distingue cette absence d'une
            # vraie panne (disque plein, permission) plutôt que d'avaler toutes les erreurs.
            msg = str(exc).lower()
            if "syntax error" not in msg and "near" not in msg:
                raise
            sortie = sqlite3.connect(str(cible))
            try:
                con.backup(sortie, pages=0)  # 0 = copie en une passe
            finally:
                sortie.close()
    finally:
        con.close()


def verifie(cible: Path) -> tuple[int, int]:
    """`integrity_check` + comptage réel. Renvoie `(tables, lignes)`, lève sinon.

    Le comptage n'est pas décoratif : `integrity_check` valide la STRUCTURE du fichier, pas
    le fait qu'il contienne quoi que ce soit. Une copie vide mais structurellement saine
    passerait le premier contrôle sans broncher.
    """
    con = sqlite3.connect(f"file:{cible}?mode=ro", uri=True)
    try:
        verdict = con.execute("PRAGMA integrity_check").fetchone()[0]
        tables = [
            r[0]
            for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        lignes = sum(con.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in tables)
    finally:
        con.close()
    if verdict != "ok":
        raise BackupError(f"integrity_check a REFUSÉ la copie : {verdict}")
    if not tables:
        raise BackupError("copie VIDE (aucune table) — sauvegarde refusée")
    return len(tables), lignes


def run(destination: Path, *, database_url: str, master_key_file: Path | None) -> Path:
    """Produit un dossier horodaté `destination/AAAAMMJJ-HHMMSS/`. Renvoie son chemin.

    Le dossier est SUPPRIMÉ si la vérification échoue : mieux vaut aucune sauvegarde qu'une
    sauvegarde à laquelle on ferait confiance à tort.
    """
    source = sqlite_path(database_url)
    if not source.exists():
        raise BackupError(f"Base introuvable : {source} — rien à sauvegarder.")

    horodatage = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    dossier = destination / horodatage
    dossier.mkdir(parents=True, exist_ok=False)
    try:
        cible = dossier / "itsm.db"
        copie_coherente(source, cible)
        tables, lignes = verifie(cible)
        taille = cible.stat().st_size / 1048576.0
        print(f"✓ {cible}  ({taille:.2f} Mio, {tables} tables, {lignes} lignes, integrity_check: ok)")

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
        description="Sauvegarde à chaud, cohérente et VÉRIFIÉE, de la base SQLite + master.key.",
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
    print("\nRestauration :")
    print("  docker compose stop")
    print(f"  docker compose run --rm --entrypoint sh itsm -c 'cp -a {dossier}/itsm.db data/itsm.db"
          " && rm -f data/itsm.db-wal data/itsm.db-shm'")
    print(f"  # puis, si présente : cp -a {dossier}/master.key data/master.key")
    print("  docker compose up -d")
    print("\n⚠️ La sauvegarde vit DANS le volume : copiez-la HORS de l'hôte "
          "(un volume perdu emporte ses sauvegardes).")
    return 0


if __name__ == "__main__":  # pragma: no cover — point d'entrée CLI
    raise SystemExit(main())
