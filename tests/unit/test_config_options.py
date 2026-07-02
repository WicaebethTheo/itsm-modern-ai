"""Options runtime étendues : getters typés, guidance prompt, round-trip config."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.adapters.secrets.encrypted import FernetSecretsBox
from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain import prompting
from itsm_modern_ai.domain.models import Referentials
from itsm_modern_ai.services.runtime_config import RuntimeConfigService


def test_get_bool_and_int(session, tmp_path):
    cfg = RuntimeConfigService(session, FernetSecretsBox(key_file=tmp_path / "k"), Settings(_env_file=None))
    assert cfg.get_bool("polling_enabled", True) is True  # défaut env
    cfg.set("polling_enabled", "false")
    assert cfg.get_bool("polling_enabled") is False
    cfg.set("llm_retries", "3")
    assert cfg.get_int("llm_retries") == 3


def test_glpi_creds_read_flags_from_config(session, tmp_path):
    cfg = RuntimeConfigService(session, FernetSecretsBox(key_file=tmp_path / "k"), Settings(_env_file=None))
    cfg.set("glpi_verify_tls", "false")
    cfg.set("glpi_followup_legacy_9x", "true")
    creds = cfg.glpi_credentials()
    assert creds.verify_tls is False and creds.followup_legacy_9x is True


def test_guidance_injected_in_prompt():
    guidance = prompting.build_guidance(
        response_tone="chaleureux", assistant_name="Support IT", routing_rules="paie → RH"
    )
    assert "chaleureux" in guidance and "Support IT" in guidance and "paie → RH" in guidance
    user = prompting.build_user_prompt("ticket masqué", Referentials(), "", guidance)
    assert "Support IT" in user and "Consignes" in user


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'cfg.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,  # admin sans mot de passe (test) — fail-closed désactivé
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_config_roundtrip_new_options(client):
    r = client.post(
        "/api/config",
        json={
            "response_tone": "concis",
            "polling_interval_seconds": 120,
            "glpi_verify_tls": False,
            "llm_retries": 2,
        },
    )
    assert r.status_code == 200
    v = r.json()
    assert v["response_tone"] == "concis"
    assert v["polling_interval_seconds"] == "120"
    assert v["glpi_verify_tls"] == "false"
    assert v["llm_retries"] == "2"


def test_interval_out_of_bounds_rejected(client):
    assert client.post("/api/config", json={"polling_interval_seconds": 5}).status_code == 422


def test_system_prompt_default_exposed_and_overridable(client):
    v = client.get("/api/config").json()
    assert v["system_prompt_default"] and "JSON" in v["system_prompt_default"]
    assert (v["system_prompt"] or "") == ""  # vide = défaut
    r = client.post("/api/config", json={"system_prompt": "Tu es un trieur strict. Réponds en JSON."})
    assert r.status_code == 200 and "trieur strict" in r.json()["system_prompt"]


def test_system_prompt_length_guard(client):
    assert client.post("/api/config", json={"system_prompt": "x" * 9000}).status_code == 422


def test_triage_uses_system_prompt_override():
    from itsm_modern_ai.domain import prompting
    from itsm_modern_ai.services.triage import TriageService

    base = dict(
        itsm=None, llm=None, settings=Settings(_env_file=None),
        tech_profiles_prose="", session_factory=lambda: None,
    )
    assert TriageService(**base)._system_prompt == prompting.SYSTEM_PROMPT  # défaut
    assert TriageService(**base, system_prompt="MON PROMPT")._system_prompt == "MON PROMPT"
