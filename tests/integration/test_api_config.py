"""API headless (FR-22 backend, FR-27) : config poussée via l'API, secrets write-only."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=f"sqlite:///{tmp_path / 'api.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,  # admin sans mot de passe (test) — fail-closed désactivé
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_health_ok_when_glpi_unconfigured(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["glpi"] == {"configured": False, "reachable": False, "version": None}


def test_status_reports_polling(client):
    body = client.get("/api/status").json()
    assert body["polling_enabled"] is False
    assert body["whitelist_loaded"] is False


def test_push_llm_key_via_api_is_write_only(client):
    r = client.post("/api/config", json={"llm_api_key": "sk-pushed-from-ui"})
    assert r.status_code == 200
    view = r.json()
    assert view["llm_api_key_set"] is True
    # La valeur du secret n'est JAMAIS renvoyée.
    assert "sk-pushed-from-ui" not in r.text
    assert "llm_api_key" not in view  # seul le booléen *_set existe


def test_push_glpi_config_and_threshold(client):
    r = client.post(
        "/api/config",
        json={
            "glpi_base_url": "https://glpi.local/apirest.php",
            "glpi_user_token": "utok",
            "confidence_threshold": 0.8,
        },
    )
    view = r.json()
    assert view["glpi_base_url"] == "https://glpi.local/apirest.php"
    assert view["glpi_user_token_set"] is True
    assert view["confidence_threshold"] == "0.8"


def test_invalid_threshold_rejected(client):
    r = client.post("/api/config", json={"confidence_threshold": 1.5})
    assert r.status_code == 422  # validation Pydantic (0..1)


# ── Anti-SSRF sur les URLs de base (durcissement audit 2026-05) ──────────────
def test_ssrf_private_url_rejected(client):
    # IP privée → refusée (sinon la clé LLM partirait vers un hôte interne).
    assert client.post("/api/config", json={"llm_base_url": "https://10.0.0.5/v1"}).status_code == 422
    # Loopback / metadata cloud → refusés.
    assert client.post("/api/config", json={"openai_base_url": "https://127.0.0.1/v1"}).status_code == 422
    assert client.post("/api/config", json={"anthropic_base_url": "https://169.254.169.254"}).status_code == 422


def test_ssrf_http_public_rejected(client):
    # http:// non toléré pour une URL publique (clé en clair sur le réseau).
    assert client.post("/api/config", json={"llm_base_url": "http://api.mistral.ai/v1"}).status_code == 422


def test_ssrf_public_https_accepted(client):
    r = client.post("/api/config", json={"openai_base_url": "https://api.openai.com/v1"})
    assert r.status_code == 200
    assert r.json()["openai_base_url"] == "https://api.openai.com/v1"


def test_ssrf_ollama_localhost_accepted(client):
    # Ollama local : http + localhost explicitement autorisés.
    r = client.post("/api/config", json={"ollama_base_url": "http://localhost:11434/v1"})
    assert r.status_code == 200
    assert r.json()["ollama_base_url"] == "http://localhost:11434/v1"


# ── M4 : garde SSRF assouplie pour GLPI on-premise (IP/host privé) ────────────
def test_glpi_private_url_accepted_by_default(client):
    # On-premise : GLPI sur IP privée accepté par défaut (GLPI_ALLOW_PRIVATE=true).
    r = client.post("/api/config", json={"glpi_base_url": "https://192.168.1.10/apirest.php"})
    assert r.status_code == 200
    assert r.json()["glpi_base_url"] == "https://192.168.1.10/apirest.php"


def test_glpi_private_http_accepted_by_default(client):
    # GLPI interne souvent en HTTP : toléré tant que le flag est vrai (hôte privé).
    r = client.post("/api/config", json={"glpi_v2_base_url": "http://10.0.0.5/api.php/v2.3"})
    assert r.status_code == 200


def test_glpi_private_url_rejected_when_flag_false(client, monkeypatch):
    # Durcissement complet : GLPI_ALLOW_PRIVATE=false → cible GLPI privée refusée.
    monkeypatch.setenv("GLPI_ALLOW_PRIVATE", "false")
    r = client.post("/api/config", json={"glpi_base_url": "https://192.168.1.10/apirest.php"})
    assert r.status_code == 422


def test_llm_private_url_still_blocked_regardless_of_glpi_flag(client):
    # Le flag GLPI n'assouplit PAS le LLM : une IP privée LLM reste bloquée (fuite de clé).
    r = client.post("/api/config", json={"llm_base_url": "https://192.168.1.10/v1"})
    assert r.status_code == 422


# ── M11 : tarifs €/Mtok éditables à chaud (cost cap juste après bascule) ──────
def test_llm_prices_editable_via_config(client):
    r = client.post(
        "/api/config",
        json={"llm_price_input_per_mtok": 9.5, "llm_price_output_per_mtok": 12.0},
    )
    assert r.status_code == 200
    view = r.json()
    assert view["llm_price_input_per_mtok"] == "9.5"
    assert view["llm_price_output_per_mtok"] == "12.0"
    # La vue /api/cost reflète les tarifs RUNTIME (surcharge UI), pas seulement le .env.
    cost = client.get("/api/cost").json()
    assert cost["price_input_per_mtok"] == 9.5
    assert cost["price_output_per_mtok"] == 12.0


def test_negative_price_rejected(client):
    assert client.post("/api/config", json={"llm_price_input_per_mtok": -1}).status_code == 422
