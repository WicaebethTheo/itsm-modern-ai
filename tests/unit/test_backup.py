"""Sauvegarde à chaud (CLI livrée dans l'image) — une sauvegarde qui ment est pire que rien."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from itsm_modern_ai.backup import BackupError, run, sqlite_path, verifie


def _base(chemin: Path, *, lignes: int = 3) -> Path:
    con = sqlite3.connect(str(chemin))
    con.execute("PRAGMA journal_mode=WAL")  # comme le moteur en production
    con.execute("CREATE TABLE decisions (id INTEGER PRIMARY KEY, subject TEXT)")
    con.executemany("INSERT INTO decisions (subject) VALUES (?)", [(f"t{i}",) for i in range(lignes)])
    con.commit()
    con.close()
    return chemin


def test_sauvegarde_verifiee_et_horodatee(tmp_path):
    src = _base(tmp_path / "itsm.db")
    cle = tmp_path / "master.key"
    cle.write_text("clef-de-test", encoding="utf-8")

    dossier = run(tmp_path / "out", database_url=f"sqlite:///{src}", master_key_file=cle)

    assert (dossier / "itsm.db").exists()
    assert (dossier / "master.key").read_text(encoding="utf-8") == "clef-de-test"
    # La copie contient RÉELLEMENT les données, pas seulement une structure valide.
    con = sqlite3.connect(f"file:{dossier / 'itsm.db'}?mode=ro", uri=True)
    assert con.execute("SELECT count(*) FROM decisions").fetchone()[0] == 3
    con.close()


def test_copie_a_chaud_embarque_le_wal_non_checkpointe(tmp_path):
    """LE défaut que `cp itsm.db` produit : en WAL, les écritures récentes vivent dans le
    `-wal`. Une copie du seul `.db` paraît réussir et se révèle muette à la restauration."""
    src = _base(tmp_path / "itsm.db")
    # Écriture NON checkpointée : elle n'est que dans le -wal.
    con = sqlite3.connect(str(src))
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("INSERT INTO decisions (subject) VALUES ('ecrit-dans-le-wal')")
    con.commit()

    dossier = run(tmp_path / "out", database_url=f"sqlite:///{src}", master_key_file=None)
    con.close()

    copie = sqlite3.connect(f"file:{dossier / 'itsm.db'}?mode=ro", uri=True)
    sujets = [r[0] for r in copie.execute("SELECT subject FROM decisions")]
    copie.close()
    assert "ecrit-dans-le-wal" in sujets, "le WAL non checkpointé n'a pas été embarqué"


def test_une_copie_vide_est_refusee(tmp_path):
    """`integrity_check` valide la STRUCTURE, pas le contenu : une base vide mais saine
    passerait le premier contrôle. D'où le comptage des tables."""
    vide = tmp_path / "vide.db"
    sqlite3.connect(str(vide)).close()
    with pytest.raises(BackupError, match="VIDE"):
        verifie(vide)


def test_echec_ne_laisse_aucun_dossier_a_moitie_fait(tmp_path):
    """Mieux vaut aucune sauvegarde qu'une sauvegarde à laquelle on ferait confiance."""
    src = tmp_path / "pas-une-base.db"
    src.write_bytes(b"ceci n'est pas du SQLite")
    dest = tmp_path / "out"
    # `sqlite3.DatabaseError` : le fichier n'est pas une base — on nomme l'exception
    # attendue plutôt qu'un `Exception` nu, qui masquerait une régression sans rapport.
    with pytest.raises(sqlite3.DatabaseError):
        run(dest, database_url=f"sqlite:///{src}", master_key_file=None)
    assert not list(dest.glob("*")), "un dossier incomplet a survécu à l'échec"


def test_base_absente_echoue_bruyamment(tmp_path):
    with pytest.raises(BackupError, match="introuvable"):
        run(tmp_path / "out", database_url=f"sqlite:///{tmp_path / 'nope.db'}", master_key_file=None)


def test_postgres_est_refuse_avec_la_marche_a_suivre(tmp_path):
    """Renvoyer « ça a marché » sur une instance Postgres serait le pire des cas :
    l'exploitant croirait avoir une sauvegarde de données qui n'ont pas été touchées."""
    with pytest.raises(BackupError, match="pg_dump"):
        sqlite_path("postgresql+psycopg://user:pwd@host:5432/itsm")


def test_master_key_absente_est_signalee_sans_bloquer(tmp_path, capsys):
    """Clé fournie par l'environnement : la sauvegarde reste valide, mais l'exploitant DOIT
    être averti qu'elle est inexploitable sans la clé."""
    src = _base(tmp_path / "itsm.db")
    run(tmp_path / "out", database_url=f"sqlite:///{src}", master_key_file=tmp_path / "absente.key")
    sortie = capsys.readouterr().out
    assert "SAUVEGARDEZ-LA AUSSI" in sortie
