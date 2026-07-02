"""Fixtures pytest partagées."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlmodel import Session

from itsm_modern_ai.domain.models import Referentials
from itsm_modern_ai.persistence import db


@pytest.fixture
def refs() -> Referentials:
    return Referentials(
        categories={1: "Compte", 2: "RH", 5: "Réseau / Sécurité"},
        technicians={11: "Sylvain", 12: "Nadia"},
    )


@pytest.fixture
def temp_db(tmp_path) -> Iterator[None]:
    """Initialise un moteur SQLite temporaire + tables, puis nettoie le global."""
    db._engine = None
    db.init_engine(f"sqlite:///{tmp_path / 'test.db'}")
    db.create_all()
    yield
    db._engine = None


@pytest.fixture
def session(temp_db) -> Iterator[Session]:
    with db.session_scope() as s:
        yield s
