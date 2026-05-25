"""Secrets chiffrés (FR-25) + service de config runtime (secrets via API, pas .env)."""

from __future__ import annotations

import pytest

from itsm_modern_ai.adapters.secrets.encrypted import FernetSecretsBox
from itsm_modern_ai.config.settings import Settings
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
