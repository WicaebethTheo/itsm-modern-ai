"""Amorçage du compte admin (FR-24) : hash stocké, jamais de clair, idempotence --force."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from sqlmodel import Session

from itsm_modern_ai.adapters.secrets.encrypted import FernetSecretsBox
from itsm_modern_ai.admin_setup import MIN_LEN, AdminSetupError, set_admin_password
from itsm_modern_ai.api.security import HASH_KEY
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.persistence import db
from itsm_modern_ai.services.runtime_config import RuntimeConfigService


def _cfg(tmp_path) -> RuntimeConfigService:
    settings = Settings(_env_file=None, database_url=f"sqlite:///{tmp_path / 'a.db'}",
                        master_key=Fernet.generate_key().decode())
    db.init_engine(settings.database_url)
    db.create_all()
    box = FernetSecretsBox(master_key=settings.master_key)
    return RuntimeConfigService(Session(db.get_engine()), box, settings)


def test_stores_hash_not_plaintext(tmp_path):
    cfg = _cfg(tmp_path)
    set_admin_password(cfg, "s3cret-pass")
    assert cfg.is_secret_set(HASH_KEY)
    stored = cfg.get_secret(HASH_KEY)
    assert stored and "s3cret-pass" not in stored  # hash Argon2, pas le clair
    assert stored.startswith("$argon2")


def test_rejects_too_short(tmp_path):
    cfg = _cfg(tmp_path)
    with pytest.raises(AdminSetupError):
        set_admin_password(cfg, "x" * (MIN_LEN - 1))
    assert not cfg.is_secret_set(HASH_KEY)


def test_refuses_overwrite_without_force(tmp_path):
    cfg = _cfg(tmp_path)
    set_admin_password(cfg, "first-pass")
    with pytest.raises(AdminSetupError):
        set_admin_password(cfg, "second-pass")


def test_force_overwrites(tmp_path):
    cfg = _cfg(tmp_path)
    set_admin_password(cfg, "first-pass")
    h1 = cfg.get_secret(HASH_KEY)
    set_admin_password(cfg, "second-pass", force=True)
    assert cfg.get_secret(HASH_KEY) != h1


# ── Politique de mot de passe côté AMORÇAGE PARESSEUX (durcissement audit 2026-08) ──
# `MIN_LEN` n'était appliqué QUE par cette CLI : `api/security._ensure_bootstrapped`
# hashait `ADMIN_PASSWORD` sans contrôle. Un mot de passe refusé par `admin_setup` (et
# donc par `docker/entrypoint.sh`, qui logue « démarrage quand même ») était ensuite
# amorcé par la première requête HTTP venue.
def test_lazy_bootstrap_refuses_short_password_and_logs_error(tmp_path, caplog):
    import logging

    from itsm_modern_ai.api import security

    cfg = _cfg(tmp_path)
    cfg.settings.admin_password = "court"  # 5 caractères < MIN_LEN
    with caplog.at_level(logging.ERROR, logger="itsm.security"):
        assert security.auth_is_configured(cfg) is False  # fail-closed
        assert security.verify_login(cfg, "court") is False
    assert not cfg.is_secret_set(HASH_KEY)  # rien n'est écrit en base
    assert any("ADMIN_PASSWORD REFUSÉ" in r.getMessage() for r in caplog.records)


def test_lazy_bootstrap_accepts_compliant_password(tmp_path):
    from itsm_modern_ai.api import security

    cfg = _cfg(tmp_path)
    cfg.settings.admin_password = "assez-long-1"
    assert security.verify_login(cfg, "assez-long-1") is True
    assert cfg.is_secret_set(HASH_KEY)


def test_password_change_bumps_session_version(tmp_path):
    """Toute rotation de mot de passe doit invalider les sessions émises (révocation)."""
    cfg = _cfg(tmp_path)
    before = cfg.session_version()
    set_admin_password(cfg, "first-pass")
    after_first = cfg.session_version()
    set_admin_password(cfg, "second-pass", force=True)
    assert after_first > before and cfg.session_version() > after_first
