"""Amorçage du compte admin (FR-24) : hash stocké, jamais de clair, idempotence --force."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from cryptography.fernet import Fernet
from sqlmodel import Session

from itsm_modern_ai.adapters.secrets.encrypted import FernetSecretsBox
from itsm_modern_ai.admin_setup import MIN_LEN, AdminSetupError, set_admin_password
from itsm_modern_ai.api.security import HASH_KEY
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.persistence import db
from itsm_modern_ai.services.runtime_config import RuntimeConfigService


@pytest.fixture
def cfg(temp_db) -> Iterator[RuntimeConfigService]:
    """Service de config branché sur le schéma jetable du test (`temp_db`).

    La session est ouverte en `with` : une session laissée ouverte garde une connexion
    « idle in transaction », donc un verrou sur les tables, et le `DROP SCHEMA` de fin
    de test s'y heurterait.
    """
    settings = Settings(_env_file=None, master_key=Fernet.generate_key().decode())
    box = FernetSecretsBox(master_key=settings.master_key)
    with Session(db.get_engine()) as session:
        yield RuntimeConfigService(session, box, settings)


def test_stores_hash_not_plaintext(cfg):
    set_admin_password(cfg, "s3cret-pass")
    assert cfg.is_secret_set(HASH_KEY)
    stored = cfg.get_secret(HASH_KEY)
    assert stored and "s3cret-pass" not in stored  # hash Argon2, pas le clair
    assert stored.startswith("$argon2")


def test_rejects_too_short(cfg):
    with pytest.raises(AdminSetupError):
        set_admin_password(cfg, "x" * (MIN_LEN - 1))
    assert not cfg.is_secret_set(HASH_KEY)


def test_refuses_overwrite_without_force(cfg):
    set_admin_password(cfg, "first-pass")
    with pytest.raises(AdminSetupError):
        set_admin_password(cfg, "second-pass")


def test_force_overwrites(cfg):
    set_admin_password(cfg, "first-pass")
    h1 = cfg.get_secret(HASH_KEY)
    set_admin_password(cfg, "second-pass", force=True)
    assert cfg.get_secret(HASH_KEY) != h1


# ── Politique de mot de passe côté AMORÇAGE PARESSEUX (durcissement audit 2026-08) ──
# `MIN_LEN` n'était appliqué QUE par cette CLI : `api/security._ensure_bootstrapped`
# hashait `ADMIN_PASSWORD` sans contrôle. Un mot de passe refusé par `admin_setup` (et
# donc par `docker/entrypoint.sh`, qui logue « démarrage quand même ») était ensuite
# amorcé par la première requête HTTP venue.
def test_lazy_bootstrap_refuses_short_password_and_logs_error(cfg, caplog):
    import logging

    from itsm_modern_ai.api import security

    cfg.settings.admin_password = "court"  # 5 caractères < MIN_LEN
    with caplog.at_level(logging.ERROR, logger="itsm.security"):
        assert security.auth_is_configured(cfg) is False  # fail-closed
        assert security.verify_login(cfg, "court") is False
    assert not cfg.is_secret_set(HASH_KEY)  # rien n'est écrit en base
    assert any("ADMIN_PASSWORD REFUSÉ" in r.getMessage() for r in caplog.records)


def test_lazy_bootstrap_accepts_compliant_password(cfg):
    from itsm_modern_ai.api import security

    cfg.settings.admin_password = "assez-long-1"
    assert security.verify_login(cfg, "assez-long-1") is True
    assert cfg.is_secret_set(HASH_KEY)


def test_password_change_bumps_session_version(cfg):
    """Toute rotation de mot de passe doit invalider les sessions émises (révocation)."""
    before = cfg.session_version()
    set_admin_password(cfg, "first-pass")
    after_first = cfg.session_version()
    set_admin_password(cfg, "second-pass", force=True)
    assert after_first > before and cfg.session_version() > after_first
