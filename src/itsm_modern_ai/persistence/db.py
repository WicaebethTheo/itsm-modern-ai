"""Moteur & sessions SQLModel. PostgreSQL est la SEULE base supportée."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlmodel import Session, SQLModel, create_engine

from . import tables  # noqa: F401  (enregistre les tables dans SQLModel.metadata)

_engine: Engine | None = None


class BaseInjoignableError(RuntimeError):
    """Le serveur PostgreSQL n'a pas répondu : la question n'a pas pu être POSÉE.

    À ne JAMAIS confondre avec « la base est vide ». Un appelant qui traiterait les deux
    de la même façon (c'était le cas : `return None` pour tout) prendrait une panne réseau
    pour un premier démarrage — cf. le garde-fou `master.key`, où cette confusion faisait
    générer une clé neuve par-dessus des secrets qu'on n'avait simplement pas su lire.
    """

# Existe-t-il DÉJÀ au moins un secret chiffré en base ? (cf. `has_encrypted_secrets`)
_HAS_SECRETS_SQL = "SELECT 1 FROM runtime_config WHERE is_secret AND value <> '' LIMIT 1"


def init_engine(
    database_url: str,
    *,
    pool_size: int = 5,
    max_overflow: int = 10,
    pool_pre_ping: bool = True,
) -> Engine:
    """Crée (une fois) le moteur PostgreSQL.

    `pool_pre_ping` teste la connexion avant de la prêter : sans lui, une coupure réseau ou
    un redémarrage du serveur laisse dans le pool des connexions mortes qui ne se révèlent
    qu'à la première requête d'un utilisateur. `pool_size` / `max_overflow` dimensionnent le
    parallélisme poller + UI.
    """
    global _engine
    _engine = create_engine(
        database_url,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_pre_ping=pool_pre_ping,
    )
    return _engine


def get_engine() -> Engine:
    if _engine is None:
        raise RuntimeError("Engine non initialisé : appeler init_engine() au démarrage.")
    return _engine


def create_all() -> None:
    """Crée les tables. Alembic reste la source de vérité pour les évolutions."""
    SQLModel.metadata.create_all(get_engine())


@contextmanager
def session_scope() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


def has_encrypted_secrets() -> bool | None:
    """`runtime_config` contient-elle DÉJÀ au moins un secret chiffré ?

    Sert de garde-fou au démarrage : si la réponse est **oui** et que `data/master.key`
    a disparu, générer une nouvelle clé rendrait tous ces secrets illisibles en silence
    (hash admin, tokens GLPI, clé LLM) — cf. `adapters/secrets/encrypted.py`.

    Trois réponses, plus une exception — et la distinction est TOUT le garde-fou :
    - `True`  : des secrets chiffrés existent → il y a bien quelque chose à perdre ;
    - `False` : base lisible et sans secret, table `runtime_config` absente comprise
      (base pas encore migrée) → premier démarrage légitime, il n'y a rien à perdre ;
    - `None`  : moteur pas encore ouvert, ou erreur SQL inattendue — indéterminé ;
    - `BaseInjoignableError` : le SERVEUR n'a pas répondu. On n'a pas pu poser la question,
      donc on ne sait pas s'il y a quelque chose à perdre. C'est le trou historique : cette
      situation rendait `None`, indistinguable d'une base vide, et l'appelant générait une
      clé neuve — qu'il PERSISTAIT, si bien qu'au démarrage suivant `key_file.exists()`
      court-circuitait le garde-fou et plus aucun boot n'avertissait jamais.

    Corollaire d'amorçage : la question ne peut être posée qu'APRÈS `init_engine()`. C'est
    pourquoi `api/app.py` ouvre le moteur avant de construire la boîte à secrets — sinon la
    réponse est invariablement `None` et le garde-fou ne protège plus rien.
    """
    if _engine is None:
        return None
    try:
        with _engine.connect() as conn:
            return conn.execute(text(_HAS_SECRETS_SQL)).first() is not None
    except OperationalError as exc:
        # Serveur éteint, DNS/port injoignable, authentification refusée, base absente :
        # psycopg les remonte tous en `OperationalError`. La question reste sans réponse.
        raise BaseInjoignableError(
            f"serveur PostgreSQL injoignable ou illisible : {exc.orig or exc}"
        ) from exc
    except ProgrammingError:
        # Table `runtime_config` absente : la base RÉPOND, elle n'est simplement pas encore
        # migrée. Il n'y a donc aucun secret à perdre — premier démarrage légitime.
        return False
    except Exception:  # noqa: BLE001 — imprévu : indéterminé, mais on ne bloque pas dessus
        return None
