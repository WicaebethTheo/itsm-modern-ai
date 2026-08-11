"""Fixtures pytest partagées."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, make_url, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool
from sqlmodel import Session

from itsm_modern_ai.domain.models import Referentials
from itsm_modern_ai.persistence import db

# PostgreSQL est la seule base supportée : les tests tournent donc sur un vrai serveur.
# Celui du poste de dev écoute sur 55432 (décalé pour ne pas entrer en conflit avec un
# PostgreSQL système sur 5432). Surchargeable pour la CI ou un serveur distant.
DEFAULT_TEST_DATABASE_URL = "postgresql+psycopg://itsm:itsm@localhost:55432/itsm"

_DEMARRER_PG = """\
PostgreSQL de test injoignable sur {url}.

Les tests exigent un vrai serveur PostgreSQL, seule base supportée. Pour en lancer un :

    docker run -d --name itsm-test-pg -p 55432:5432 \\
      -e POSTGRES_USER=itsm -e POSTGRES_PASSWORD=itsm -e POSTGRES_DB=itsm postgres:17-alpine

Pour viser un autre serveur : TEST_DATABASE_URL=postgresql+psycopg://user:pwd@host:port/base

Erreur d'origine : {erreur}"""


def _base_test_url():
    return make_url(os.environ.get("TEST_DATABASE_URL") or DEFAULT_TEST_DATABASE_URL)


@pytest.fixture
def refs() -> Referentials:
    return Referentials(
        categories={1: "Compte", 2: "RH", 5: "Réseau / Sécurité"},
        technicians={11: "Sylvain", 12: "Nadia"},
    )


@contextmanager
def _schema_jetable() -> Iterator[str]:
    """Crée un SCHÉMA PostgreSQL jetable et rend l'URL qui l'y épingle ; le détruit après.

    Un schéma neuf par test remplace le fichier de base jetable d'avant : même isolation
    (aucune ligne, aucune séquence, aucun index partagés avec un autre test), sans exiger
    une base PostgreSQL par test — `CREATE DATABASE` coûte bien plus cher qu'un schéma et
    ne peut pas tourner dans une transaction.

    Le `search_path` est fixé dans l'URL (`options=-csearch_path=…`), donc appliqué par
    libpq à l'ÉTABLISSEMENT de chaque connexion : toute connexion du pool — y compris
    celles ouvertes après coup, sous un autre thread — voit le bon schéma, ce qu'un `SET`
    émis après coup ne garantit pas.
    """
    base_url = _base_test_url()
    schema = f"test_{uuid.uuid4().hex}"

    # Connexion d'administration séparée : elle crée/détruit le schéma et ne doit donc pas
    # être elle-même épinglée dessus (le DROP échouerait sur un search_path devenu invalide).
    admin = create_engine(base_url, poolclass=NullPool)
    try:
        with admin.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    except SQLAlchemyError as exc:
        admin.dispose()
        pytest.fail(
            _DEMARRER_PG.format(url=base_url.render_as_string(), erreur=exc), pytrace=False
        )

    try:
        yield base_url.update_query_dict({"options": f"-csearch_path={schema}"}).render_as_string(
            hide_password=False
        )
    finally:
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.fixture
def db_url(monkeypatch) -> Iterator[str]:
    """URL PostgreSQL jetable à passer à `Settings(database_url=...)`.

    Du temps d'une base fichier, chaque test API fabriquait la sienne sous `tmp_path` : un
    fichier neuf suffisait à isoler, et personne n'avait à le refermer. Sur PostgreSQL il
    faut les deux moitiés — un schéma neuf ET la fermeture des moteurs qui pointent dessus
    — d'où cette fixture plutôt qu'une chaîne recopiée dans vingt fichiers.

    C'est le code TESTÉ qui ouvre le moteur ici (`create_app` appelle `db.init_engine`), pas
    la fixture : on emballe donc `init_engine` pour tenir la liste des moteurs réellement
    ouverts pendant le test. Les fermer tous — pas seulement `db._engine` — est nécessaire :
    un test qui construit deux applications (changement de mot de passe, seconde instance)
    laisse le premier moteur orphelin, et une session restée ouverte dessus garde un verrou
    qui ferait échouer le `DROP SCHEMA`.
    """
    moteurs = []
    vrai_init_engine = db.init_engine

    def _init_engine(*args, **kwargs):
        moteur = vrai_init_engine(*args, **kwargs)
        moteurs.append(moteur)
        return moteur

    monkeypatch.setattr(db, "init_engine", _init_engine)
    with _schema_jetable() as url:
        try:
            yield url
        finally:
            for moteur in moteurs:
                moteur.dispose()
            db._engine = None


@pytest.fixture
def temp_db() -> Iterator[None]:
    """Moteur PostgreSQL global (`db._engine`) ouvert sur un schéma jetable.

    Pour les tests qui parlent directement à la persistance (`db.session_scope()`) sans
    passer par `create_app` — lequel ouvre lui-même le moteur depuis `db_url`.
    """
    with _schema_jetable() as url:
        db._engine = None
        db.init_engine(url)
        db.create_all()
        try:
            yield
        finally:
            # `dispose()` d'abord : un DROP SCHEMA se heurterait aux connexions encore
            # ouvertes dans le pool (verrou sur les tables du schéma).
            db.get_engine().dispose()
            db._engine = None


@pytest.fixture
def session(temp_db) -> Iterator[Session]:
    with db.session_scope() as s:
        yield s
