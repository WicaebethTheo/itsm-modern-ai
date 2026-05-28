"""Endpoint sandbox (triage à blanc, sans écriture GLPI) — LLM mocké via respx."""

from __future__ import annotations

import httpx
import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings

LLM_BASE = "https://llm.test/v1"


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=f"sqlite:///{tmp_path / 'sbx.db'}",
        master_key=Fernet.generate_key().decode(),
        llm_base_url=LLM_BASE,
        polling_enabled=False,
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_sandbox_requires_llm_configured(client):
    r = client.post("/api/sandbox", json={"content": "pc lent"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "llm_not_configured"


@respx.mock
def test_sandbox_returns_decision_without_writing(client):
    # Pousser la clé LLM via l'API (comme le ferait l'UI).
    client.post("/api/config", json={"llm_api_key": "sk-test"})
    # Charger une whitelist en cache via le câblage interne, ET en base — pour que
    # les noms (catégorie / technicien) soient résolus comme dans le Journal.
    from itsm_modern_ai.domain.models import Referentials
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services import referentials

    refs = Referentials(categories={1: "Compte"}, technicians={11: "Syl"})
    client.app.state.whitelist_cache.refresh(refs)
    with db.session_scope() as s:
        referentials.sync(s, refs)
    decision_json = (
        '{"category":1,"priority":3,"technician_id":11,"draft":"Bonjour","confidence":0.88}'
    )
    respx.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": decision_json}}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 10},
            },
        )
    )
    r = client.post("/api/sandbox", json={"content": "je n'arrive plus à me connecter"})
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] is True
    assert body["technician_id"] == 11 and body["confidence"] == 0.88
    # Noms résolus depuis le ReferentialCache (utilisés par l'UI pour afficher « Syl » + #11).
    assert body["category_name"] == "Compte"
    assert body["technician_name"] == "Syl"
