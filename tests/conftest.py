"""Fixtures pytest partagées."""

from __future__ import annotations

import pytest

from itsm_modern_ai.domain.models import Referentials


@pytest.fixture
def refs() -> Referentials:
    return Referentials(
        categories={1: "Compte", 2: "RH", 5: "Réseau / Sécurité"},
        technicians={11: "Sylvain", 12: "Nadia"},
    )
