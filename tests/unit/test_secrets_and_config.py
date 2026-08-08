"""Secrets chiffrés (FR-25) + service de config runtime (secrets via API, pas .env)."""

from __future__ import annotations

import sqlite3

import pytest
from cryptography.fernet import Fernet

from itsm_modern_ai.adapters.secrets.encrypted import (
    ALLOW_NEW_KEY_ENV,
    FernetSecretsBox,
    MasterKeyLostError,
)
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain.errors import SecretDecryptError
from itsm_modern_ai.persistence import db
from itsm_modern_ai.services.runtime_config import RuntimeConfigService


def _box(tmp_path) -> FernetSecretsBox:
    return FernetSecretsBox(key_file=tmp_path / "master.key")


def test_fernet_roundtrip_and_not_plaintext(tmp_path):
    box = _box(tmp_path)
    token = box.encrypt("sk-secret-123")
    assert token != "sk-secret-123"
    assert "secret" not in token
    assert box.decrypt(token) == "sk-secret-123"


def test_secret_stored_encrypted_and_readable(session, tmp_path):
    cfg = RuntimeConfigService(session, _box(tmp_path), Settings())
    assert cfg.is_secret_set("llm_api_key") is False
    cfg.set_secret("llm_api_key", "sk-abc")
    assert cfg.is_secret_set("llm_api_key") is True
    # En base, la valeur est chiffrée (pas en clair).
    from itsm_modern_ai.persistence.tables import RuntimeConfig

    row = session.get(RuntimeConfig, "llm_api_key")
    assert row.is_secret and "sk-abc" not in row.value
    # Mais lisible via le service.
    assert cfg.get_secret("llm_api_key") == "sk-abc"


def test_plain_override_else_env_default(session, tmp_path):
    settings = Settings(llm_model="env-model")
    cfg = RuntimeConfigService(session, _box(tmp_path), settings)
    assert cfg.get("llm_model") == "env-model"  # défaut env
    cfg.set("llm_model", "mistral-small-latest")
    assert cfg.get("llm_model") == "mistral-small-latest"  # surcharge base


def test_glpi_credentials_assembly(session, tmp_path):
    settings = Settings(glpi_base_url="https://glpi.local/apirest.php")
    cfg = RuntimeConfigService(session, _box(tmp_path), settings)
    assert cfg.glpi_credentials().is_configured is False  # pas de token
    cfg.set_secret("glpi_user_token", "utok")
    creds = cfg.glpi_credentials()
    assert creds.is_configured and creds.user_token == "utok"


def test_unknown_secret_key_rejected(session, tmp_path):
    cfg = RuntimeConfigService(session, _box(tmp_path), Settings())
    with pytest.raises(ValueError):
        cfg.set_secret("not_a_secret", "x")


def test_decrypt_with_wrong_key_raises_business_error(tmp_path):
    """Fail-safe (audit 2026-05) : un token chiffré avec une clé A, lu avec une clé B,
    lève une `SecretDecryptError` métier (et non un `InvalidToken` brut → 500)."""
    box_a = FernetSecretsBox(master_key=Fernet.generate_key().decode())
    box_b = FernetSecretsBox(master_key=Fernet.generate_key().decode())
    token = box_a.encrypt("sk-secret-123")
    with pytest.raises(SecretDecryptError):
        box_b.decrypt(token)


def test_decrypt_corrupted_token_raises_business_error(tmp_path):
    box = _box(tmp_path)
    with pytest.raises(SecretDecryptError):
        box.decrypt("ceci-n-est-pas-un-token-fernet")


def test_get_secret_propagates_business_error_not_500(session, tmp_path):
    """Un secret en base chiffré avec une autre clé → SecretDecryptError gérée, pas brute."""
    # Écrit un secret avec une clé, puis lit avec un service muni d'une autre clé.
    box_a = FernetSecretsBox(master_key=Fernet.generate_key().decode())
    RuntimeConfigService(session, box_a, Settings()).set_secret("llm_api_key", "sk-abc")
    box_b = FernetSecretsBox(master_key=Fernet.generate_key().decode())
    cfg_b = RuntimeConfigService(session, box_b, Settings())
    with pytest.raises(SecretDecryptError):
        cfg_b.get_secret("llm_api_key")


# ── Perte de data/master.key : fail-fast au lieu d'un démarrage « vert » mais cassé ──
# Sans garde-fou : nouvelle clé générée en silence → login « Mot de passe incorrect »
# (diagnostic trompeur), /health en 500, /api/status en 200 (la supervision ne voit
# rien) et l'amorçage au boot ne répare RIEN (`is_secret_set` ne déchiffre pas).


def _sqlite_with_secret(path, *, secret: bool = True) -> None:
    """Base SQLite minimale portant (ou non) un secret chiffré dans runtime_config."""
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE runtime_config (key TEXT PRIMARY KEY, value TEXT, is_secret INT)")
    con.execute(
        "INSERT INTO runtime_config VALUES ('admin_password_hash', 'gAAAA-token', ?)",
        (1 if secret else 0,),
    )
    con.commit()
    con.close()


def test_master_key_lost_with_existing_secrets_refuses_to_start(session, tmp_path):
    """Base avec secrets + master.key disparue → refus explicite, AUCUNE clé générée."""
    box = FernetSecretsBox(master_key=Fernet.generate_key().decode())
    RuntimeConfigService(session, box, Settings()).set_secret("llm_api_key", "sk-abc")
    session.commit()

    key_file = tmp_path / "master.key"
    with pytest.raises(MasterKeyLostError) as exc:
        FernetSecretsBox(key_file=key_file)
    assert not key_file.exists()  # surtout ne rien écrire : la restauration reste possible
    message = str(exc.value)
    assert "master.key" in message and "sauvegarde" in message  # message actionnable
    assert ALLOW_NEW_KEY_ENV in message


def test_first_boot_with_empty_database_still_generates_key(session, tmp_path):
    """Premier démarrage légitime (base sans aucun secret) : génération normale."""
    key_file = tmp_path / "master.key"
    box = FernetSecretsBox(key_file=key_file)
    assert key_file.exists() and box.decrypt(box.encrypt("x")) == "x"


def test_no_database_at_all_generates_key(tmp_path, monkeypatch):
    """Ni moteur ouvert ni base : question indécidable → on ne bloque pas l'install."""
    monkeypatch.setattr(db, "_engine", None)
    key_file = tmp_path / "master.key"
    FernetSecretsBox(key_file=key_file)
    assert key_file.exists()


def test_sibling_sqlite_detected_before_engine_is_open(tmp_path, monkeypatch):
    """Le garde-fou vaut AUSSI avant `init_engine()` : l'app construit sa boîte à secrets
    (dérivation du secret de session) avant d'ouvrir le moteur — on lit alors la base
    SQLite voisine du fichier de clé, soit exactement le contenu du volume ./data."""
    monkeypatch.setattr(db, "_engine", None)
    _sqlite_with_secret(tmp_path / "itsm.db")
    with pytest.raises(MasterKeyLostError):
        FernetSecretsBox(key_file=tmp_path / "master.key")


def test_sibling_sqlite_without_secrets_does_not_block(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_engine", None)
    _sqlite_with_secret(tmp_path / "itsm.db", secret=False)
    FernetSecretsBox(key_file=tmp_path / "master.key")
    assert (tmp_path / "master.key").exists()


def test_explicit_escape_hatch_allows_a_new_key(tmp_path, monkeypatch):
    """« Je repars de zéro en connaissance de cause » reste possible, mais EXPLICITE."""
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setenv(ALLOW_NEW_KEY_ENV, "true")
    _sqlite_with_secret(tmp_path / "itsm.db")
    FernetSecretsBox(key_file=tmp_path / "master.key")
    assert (tmp_path / "master.key").exists()


def test_master_key_from_env_bypasses_the_guard(tmp_path, monkeypatch):
    """MASTER_KEY fournie : aucune génération, donc rien à garder — pas de blocage."""
    monkeypatch.setattr(db, "_engine", None)
    _sqlite_with_secret(tmp_path / "itsm.db")
    box = FernetSecretsBox(master_key=Fernet.generate_key().decode(), key_file=tmp_path / "k")
    assert box.decrypt(box.encrypt("x")) == "x"


def test_has_encrypted_secrets_answers_none_when_undecidable(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_engine", None)
    assert db.has_encrypted_secrets(tmp_path / "absente.db") is None
    assert db.has_encrypted_secrets(None) is None
    (tmp_path / "vide.db").write_bytes(b"pas une base sqlite")
    assert db.has_encrypted_secrets(tmp_path / "vide.db") is None


def test_has_encrypted_secrets_uses_the_open_engine(session):
    """Moteur ouvert (cas nominal du boot) : la réponse vient de la base réelle."""
    assert db.has_encrypted_secrets() is False
    box = FernetSecretsBox(master_key=Fernet.generate_key().decode())
    RuntimeConfigService(session, box, Settings()).set_secret("glpi_user_token", "t")
    session.commit()
    assert db.has_encrypted_secrets() is True
