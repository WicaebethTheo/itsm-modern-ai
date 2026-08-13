"""Sauvegarde à chaud (CLI livrée dans l'image) — une sauvegarde qui ment est pire que rien.

Ces tests parlent à un VRAI PostgreSQL (même serveur que le reste de la suite) : une
sauvegarde se juge sur un dump réellement produit et réellement relu, pas sur des appels
`pg_dump` simulés qui valideraient surtout notre propre mock.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import uuid
from collections.abc import Iterator
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, make_url, text
from sqlalchemy.pool import NullPool

from itsm_modern_ai.backup import BackupError, connexion_libpq, main, run, verifie

# Même serveur (et même variable d'environnement) que tests/conftest.py. Les tests de
# sauvegarde ne peuvent pas se contenter du SCHÉMA jetable des autres tests : `pg_dump`
# travaille sur une BASE entière, il faut donc en créer une, jetable elle aussi.
URL_ADMIN = os.environ.get("TEST_DATABASE_URL") or "postgresql+psycopg://itsm:itsm@localhost:55432/itsm"


def _major(texte: str) -> int:
    trouve = re.search(r"(\d+)\.\d+", texte)
    return int(trouve.group(1)) if trouve else 0


def abandonne(motif: str) -> None:
    """Ignore le test en local, ÉCHOUE en CI (`CI` est posée par GitHub Actions).

    Ces tests sont le seul endroit qui prouve que la sauvegarde ne ment pas. Tant qu'ils
    pouvaient s'ignorer partout, ils s'ignoraient là où ça comptait : faute de
    `postgresql-client-17` sur le runner, la CI mesurait « 577 passed, 8 skipped » et
    restait verte — couverture au-dessus du cliquet comprise — sans avoir vérifié une seule
    fois une archive. Un contrat verrouillé par ailleurs ne doit pas pouvoir se
    neutraliser tout seul ; en local, en revanche, un poste sans client PostgreSQL n'a pas
    à bloquer le reste de la suite.
    """
    if os.environ.get("CI"):
        pytest.fail(
            f"{motif}\n"
            "En CI, s'ignorer n'est pas une option : les tests de sauvegarde DOIVENT "
            "tourner (cf. l'étape « Client PostgreSQL 17 » des workflows).",
            pytrace=False,
        )
    pytest.skip(motif)


@pytest.fixture(scope="module")
def base_jetable() -> Iterator[str]:
    """Crée une BASE PostgreSQL jetable et rend son URL ; la détruit ensuite."""
    if shutil.which("pg_dump") is None:
        abandonne("pg_dump absent (paquet postgresql-client) — présent dans l'image livrée")

    admin_url = make_url(URL_ADMIN)
    admin = create_engine(admin_url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            serveur = _major(conn.execute(text("SHOW server_version")).scalar_one())
    except Exception as exc:  # noqa: BLE001 — message actionnable, cf. conftest
        admin.dispose()
        abandonne(f"PostgreSQL de test injoignable sur {admin_url.render_as_string()} : {exc}")

    client = _major(subprocess.run(["pg_dump", "--version"], capture_output=True, text=True).stdout)
    if client < serveur:
        # `pg_dump` refuse de dumper un serveur d'une majeure SUPÉRIEURE à la sienne. On le
        # dit explicitement plutôt que de laisser un échec cryptique : c'est exactement le
        # désalignement que le Dockerfile et les composes s'interdisent (client 17 / PG 17).
        abandonne(f"pg_dump {client} plus ancien que le serveur {serveur} — client à aligner")

    nom = f"itsm_backup_{uuid.uuid4().hex[:12]}"
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{nom}"'))
    try:
        yield admin_url.set(database=nom).render_as_string(hide_password=False)
    finally:
        with admin.connect() as conn:
            # FORCE : une connexion résiduelle bloquerait le DROP et laisserait des bases
            # de test derrière elle à chaque exécution.
            conn.execute(text(f'DROP DATABASE IF EXISTS "{nom}" WITH (FORCE)'))
        admin.dispose()


@pytest.fixture
def base(base_jetable) -> Iterator[str]:
    """Base jetable REMISE À ZÉRO avant chaque test (schéma public recréé)."""
    moteur = create_engine(base_jetable, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    with moteur.connect() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    moteur.dispose()
    yield base_jetable


def _remplit(url: str, *, lignes: int = 3) -> None:
    moteur = create_engine(url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    with moteur.connect() as conn:
        conn.execute(text("CREATE TABLE decisions (id serial PRIMARY KEY, sujet text)"))
        conn.execute(text("CREATE TABLE vide (id serial PRIMARY KEY)"))
        for i in range(lignes):
            conn.execute(text("INSERT INTO decisions (sujet) VALUES (:s)"), {"s": f"t{i}"})
    moteur.dispose()


def _dump_brut(url: str, cible, *options: str) -> None:
    """`pg_dump` direct, pour fabriquer des archives volontairement défectueuses."""
    args, env = connexion_libpq(url)
    subprocess.run(
        ["pg_dump", *args, "--format=custom", *options, "--file", str(cible)],
        env=env, check=True, capture_output=True,
    )


def test_sauvegarde_verifiee_et_horodatee(base, tmp_path):
    cle = tmp_path / "master.key"
    cle.write_text("clef-de-test", encoding="utf-8")
    _remplit(base)

    dossier = run(tmp_path / "out", database_url=base, master_key_file=cle)

    archive = dossier / "itsm.dump"
    assert archive.exists() and archive.stat().st_size > 0
    assert (dossier / "master.key").read_text(encoding="utf-8") == "clef-de-test"
    # L'archive contient RÉELLEMENT les données, pas seulement une structure valide :
    # on la relit avec l'outil qui servira à restaurer.
    donnees = subprocess.run(
        ["pg_restore", "--data-only", "-f", "-", str(archive)],
        capture_output=True, text=True, check=True,
    ).stdout
    assert "COPY public.decisions" in donnees
    # Une ligne de COPY = « <id>\t<sujet> » : les trois sujets insérés sont bien là.
    assert [s for s in ("\tt0\n", "\tt1\n", "\tt2\n") if s in donnees] == ["\tt0\n", "\tt1\n", "\tt2\n"]


def test_l_archive_n_est_lisible_que_par_son_proprietaire(base, tmp_path):
    """Une sauvegarde, c'est la base RGPD ENTIÈRE dans un fichier.

    Contenu des tickets, journal des appels LLM — donc les prompts et les réponses, PII non
    masquées comprises en édition Community (IBAN, secrets, IP, NIR) — et les secrets
    chiffrés. Sans mode explicite, `mkdir` et `pg_dump --file` créent avec l'umask du
    process : 0755 pour le dossier, 0644 pour le dump. Sur le volume bind-monté d'un hôte
    mutualisé, tout utilisateur local lisait donc l'intégralité des données personnelles.

    Le contrat existait déjà pour la `master.key` (0600, `backup.py`) et pour le `.env`
    (`chmod 600`, `install.sh`) : c'est le fichier qui porte les données qui l'avait perdu.
    """
    cle = tmp_path / "master.key"
    cle.write_text("clef-de-test", encoding="utf-8")
    _remplit(base)

    dossier = run(tmp_path / "out", database_url=base, master_key_file=cle)

    assert stat.S_IMODE(dossier.stat().st_mode) == 0o700, "le dossier de sauvegarde est traversable"
    for nom in ("itsm.dump", "master.key"):
        mode = stat.S_IMODE((dossier / nom).stat().st_mode)
        assert mode == 0o600, f"{nom} lisible au-delà de son propriétaire ({oct(mode)})"


def test_une_archive_sans_donnees_est_refusee(base, tmp_path):
    """L'équivalent PostgreSQL du piège SQLite « structure valide mais fichier vide ».

    Une archive `--schema-only` passe le contrôle de STRUCTURE (`pg_restore --list` la lit
    sans broncher, elle décrit bien les tables) et ne contient pas une seule ligne. C'est
    exactement la sauvegarde qui paraît réussir et se révèle inutile à la restauration.
    """
    _remplit(base)
    archive = tmp_path / "schema-seul.dump"
    _dump_brut(base, archive, "--schema-only")

    with pytest.raises(BackupError, match="aucune table"):
        verifie(archive, {"decisions": 3, "vide": 0})


def test_une_table_absente_de_l_archive_est_refusee(base, tmp_path):
    """Une archive amputée d'UNE table est le pire cas : elle se restaure sans erreur et
    l'exploitant ne découvre le trou que plus tard. On compare donc la table des matières
    à la liste réelle des tables de la base."""
    _remplit(base)
    archive = tmp_path / "partielle.dump"
    _dump_brut(base, archive, "--exclude-table-data=decisions")

    with pytest.raises(BackupError, match="ABSENTE"):
        verifie(archive, {"decisions": 3, "vide": 0})


def test_une_archive_tronquee_est_refusee(base, tmp_path):
    """Le contrôle de structure NE SUFFIT PAS : la table des matières vit en tête d'archive,
    `pg_restore --list` la lit encore alors que les données sont amputées. Seule la
    relecture intégrale des blocs de données attrape une archive coupée (disque plein…)."""
    _remplit(base, lignes=2000)
    archive = tmp_path / "itsm.dump"
    _dump_brut(base, archive)
    entier = archive.read_bytes()
    archive.write_bytes(entier[:-512])  # on ampute la QUEUE : les données, pas la TOC

    # Le contrôle n°1 seul laisserait passer…
    args, env = connexion_libpq(base)
    assert subprocess.run(
        ["pg_restore", "--list", str(archive)], env=env, capture_output=True
    ).returncode == 0
    # … le contrôle n°2 non.
    with pytest.raises(BackupError, match="relecture"):
        verifie(archive, {"decisions": 2000, "vide": 0})


def test_une_table_videe_dans_l_archive_est_refusee(base, tmp_path):
    """Comptage des lignes, pas seulement des tables : une table présente mais vide alors
    que la base en contient est une sauvegarde silencieusement amputée."""
    _remplit(base)
    archive = tmp_path / "itsm.dump"
    _dump_brut(base, archive)

    with pytest.raises(BackupError, match="VIDE"):
        verifie(archive, {"decisions": 3, "vide": 12})


def test_echec_ne_laisse_aucun_dossier_a_moitie_fait(base, tmp_path, monkeypatch):
    """Mieux vaut aucune sauvegarde qu'une sauvegarde à laquelle on ferait confiance."""
    _remplit(base)
    dest = tmp_path / "out"
    monkeypatch.setattr(
        "itsm_modern_ai.backup.dump",
        lambda *a, **k: (_ for _ in ()).throw(BackupError("disque plein")),
    )
    with pytest.raises(BackupError, match="disque plein"):
        run(dest, database_url=base, master_key_file=None)
    assert not list(dest.glob("*")), "un dossier incomplet a survécu à l'échec"


def test_base_injoignable_echoue_bruyamment(tmp_path):
    injoignable = make_url(URL_ADMIN).set(port=1).render_as_string(hide_password=False)
    with pytest.raises(BackupError, match="injoignable"):
        run(tmp_path / "out", database_url=injoignable, master_key_file=None)
    assert not (tmp_path / "out").exists()


def test_une_url_non_postgres_est_refusee(tmp_path):
    """PostgreSQL est la seule base supportée : renvoyer « ça a marché » sur une autre URL
    ferait croire à l'exploitant qu'il détient une sauvegarde."""
    with pytest.raises(BackupError, match="seule base supportée"):
        run(tmp_path / "out", database_url="sqlite:///./data/itsm.db", master_key_file=None)


def test_le_mot_de_passe_ne_passe_jamais_par_la_ligne_de_commande():
    """`ps` est lisible par tous dans le conteneur : le secret passe par PGPASSWORD."""
    args, env = connexion_libpq("postgresql+psycopg://itsm:s3cr3t@postgres:5432/itsm")
    assert env["PGPASSWORD"] == "s3cr3t"
    assert "s3cr3t" not in " ".join(args)
    assert "postgres:5432" in " ".join(args)


def test_la_cli_affiche_la_procedure_de_restauration(base, tmp_path, monkeypatch, capsys):
    """Une sauvegarde qu'on ne sait pas restaurer ne sert à rien : la marche à suivre est
    imprimée AU MOMENT où l'exploitant sauvegarde, pas seulement dans la documentation
    (à 2 h du matin, on relit le journal de la dernière sauvegarde)."""
    _remplit(base)
    monkeypatch.setattr("itsm_modern_ai.backup.get_settings", lambda: SimpleNamespace(database_url=base))
    monkeypatch.chdir(tmp_path)  # `data/master.key` est un chemin relatif

    assert main(["--dest", "out"]) == 0

    sortie = capsys.readouterr().out
    assert "pg_restore" in sortie
    assert "master.key" in sortie
    # … et la procédure ne doit pas propager le piège de `--clean` : il ne supprime que les
    # objets PRÉSENTS DANS L'ARCHIVE, donc une table créée par une migration postérieure à
    # la sauvegarde survit pendant qu'`alembic_version` est rembobiné — la restauration
    # semble réussir, la mise à jour suivante meurt sur « relation ... already exists ».
    assert "--clean" not in sortie
    assert "DROP SCHEMA" in sortie and "CREATE SCHEMA public" in sortie


def test_la_cli_echoue_avec_un_code_de_sortie_non_nul(tmp_path, monkeypatch, capsys):
    """Un `docker compose exec … backup` qui sort en 0 alors qu'il n'a rien produit ferait
    passer une tâche cron de sauvegarde pour verte pendant des mois."""
    injoignable = make_url(URL_ADMIN).set(port=1).render_as_string(hide_password=False)
    monkeypatch.setattr(
        "itsm_modern_ai.backup.get_settings", lambda: SimpleNamespace(database_url=injoignable)
    )
    monkeypatch.chdir(tmp_path)

    assert main(["--dest", "out"]) == 1
    assert "✗" in capsys.readouterr().err


def test_ces_tests_ne_peuvent_pas_s_ignorer_en_ci(monkeypatch):
    """Le contrat des contrats : en CI, un test de sauvegarde absent doit RENDRE ROUGE.

    C'est ce qui manquait. Faute de client PostgreSQL aligné sur le runner, ces tests
    s'ignoraient : `577 passed, 8 skipped`, couverture au-dessus du cliquet, aucune alerte —
    des « tests verts » qui ne contenaient plus aucune vérification réelle de la sauvegarde.
    """
    monkeypatch.setenv("CI", "true")
    with pytest.raises(pytest.fail.Exception, match="pg_dump absent"):
        abandonne("pg_dump absent")

    monkeypatch.delenv("CI")  # poste de dev : on n'impose pas d'installer le client
    with pytest.raises(pytest.skip.Exception):
        abandonne("pg_dump absent")


def test_master_key_absente_est_signalee_sans_bloquer(base, tmp_path, capsys):
    """Clé fournie par l'environnement : la sauvegarde reste valide, mais l'exploitant DOIT
    être averti qu'elle est inexploitable sans la clé."""
    _remplit(base)
    run(tmp_path / "out", database_url=base, master_key_file=tmp_path / "absente.key")
    assert "SAUVEGARDEZ-LA AUSSI" in capsys.readouterr().out
