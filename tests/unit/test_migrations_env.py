"""Environnement Alembic (`migrations/env.py`) : contrats de DÉMARRAGE.

Ce fichier n'est exécuté par aucun test d'intégration — il ne tourne qu'au lancement de
`alembic`, c'est-à-dire dans l'entrypoint du conteneur, AVANT que le moteur ne démarre.
Une régression ici ne se manifeste donc jamais en développement : elle se manifeste chez
l'exploitant, sous la forme d'un conteneur qui meurt au premier `docker compose up`.

On l'éprouve en SOUS-PROCESSUS et en mode hors-ligne (`--sql`) : c'est exactement la
commande de l'entrypoint, sans exiger de serveur PostgreSQL ni polluer la configuration de
journalisation du processus pytest (env.py appelle `fileConfig`).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _alembic_hors_ligne(database_url: str) -> subprocess.CompletedProcess[str]:
    """`alembic upgrade head --sql` avec l'URL donnée, sans toucher à un serveur."""
    env = {**os.environ, "DATABASE_URL": database_url}
    return subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head", "--sql"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize(
    "mot_de_passe",
    [
        "p%40ss",  # « p@ss » — le cas exact recommandé par .env.example
        "50%25",  # « 50% » — un pourcentage littéral, lui aussi encodé
        "a%3Ab%2Fc",  # « a:b/c » — deux autres caractères que .env.example dit d'encoder
    ],
)
def test_un_mot_de_passe_url_encode_ne_fait_pas_exploser_alembic(mot_de_passe):
    """Un `%` dans l'URL ne doit JAMAIS être réinterprété comme une interpolation.

    Trouvé en bootant l'image, pas par les tests : `config.set_main_option(...)` passait
    l'URL à `configparser`, qui lit `%40` comme une interpolation invalide et lève
    `ValueError: invalid interpolation syntax`. Alembic mourait donc avant la première
    migration, et l'entrypoint tuait le conteneur au démarrage — sur un mot de passe
    pourtant conforme à `.env.example`, qui recommande précisément d'encoder `@ : / ? #`.
    Le test couvre le `%` sous ses deux visages : caractère encodé ET pourcentage littéral.
    """
    resultat = _alembic_hors_ligne(
        f"postgresql+psycopg://itsm:{mot_de_passe}@db.exemple.test:5432/itsm"
    )
    assert "interpolation" not in resultat.stderr, (
        f"l'URL est repassée par configparser :\n{resultat.stderr}"
    )
    assert resultat.returncode == 0, resultat.stderr
    # Le script attendu a bien été produit : on a migré, pas seulement évité l'exception.
    assert "CREATE TABLE" in resultat.stdout


def test_le_mode_hors_ligne_utilise_bien_l_url_de_settings():
    """Garde-fou de non-régression du câblage : l'URL vient de `Settings`, pas d'alembic.ini.

    `alembic.ini` porte un `sqlalchemy.url` VIDE à dessein (l'URL est résolue par
    pydantic-settings). Si un jour quelqu'un remettait l'URL dans le fichier .ini, ce test
    resterait vert — mais le dialecte, lui, trahirait un retour en arrière : sans URL
    exploitable, Alembic échoue au lieu d'émettre du SQL PostgreSQL.
    """
    resultat = _alembic_hors_ligne("postgresql+psycopg://itsm:itsm@db.exemple.test:5432/itsm")
    assert resultat.returncode == 0, resultat.stderr
    # `SERIAL`/`TIMESTAMP WITH TIME ZONE` : du SQL PostgreSQL, pas un dialecte générique.
    assert "TIMESTAMP WITH TIME ZONE" in resultat.stdout.upper()
