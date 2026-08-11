"""`GET /api/status` à deux niveaux (durcissement audit 2026-06).

Public : strict état de marche (ok, version, polling) — l'installeur sonde cet endpoint
et attend un 200 SANS auth. Enrichi (compteurs LLM, coût 24 h, plafond, volumétrie des
référentiels) : uniquement avec une session admin valide. Les valeurs polling/plafond
sont les valeurs RUNTIME (surcharges UI), pas les seules valeurs d'environnement.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai import __version__
from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings

ENRICHED_FIELDS = {
    "polling_interval_seconds",
    "whitelist_loaded",
    "categories_count",
    "technicians_count",
    "llm_calls_total",
    "cost_eur_last_24h",
    "cost_cap_eur_per_day",
}


def _settings(db_url, **kw) -> Settings:
    kw.setdefault("session_https_only", False)  # TestClient = http → cookie non-Secure
    return Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


EMAIL = "admin@exemple.fr"
PASSWORD = "s3cret-pilote"


@pytest.fixture
def secured_client(db_url, creer_compte_admin):
    """Instance protégée : le compte est créé par HTTP (première visite), puis déconnecté."""
    with TestClient(create_app(_settings(db_url))) as c:
        creer_compte_admin(c, email=EMAIL, password=PASSWORD)
        yield c


def test_public_status_is_minimal_no_cost_nor_volumetry(secured_client):
    """Non authentifié : 200 (installeur) mais AUCUN compteur/coût/volumétrie divulgué."""
    r = secured_client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["version"] == __version__
    assert body["polling_enabled"] is False
    assert ENRICHED_FIELDS.isdisjoint(body.keys())


def test_authenticated_status_is_enriched(secured_client):
    secured_client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    body = secured_client.get("/api/status").json()
    assert body["ok"] is True and body["version"] == __version__
    assert ENRICHED_FIELDS <= body.keys()
    assert body["whitelist_loaded"] is False
    assert body["llm_calls_total"] == 0
    assert body["cost_cap_eur_per_day"] == 5.0


def test_status_stays_200_when_fail_closed(db_url):
    """Fail-closed (pas de mot de passe, pas de dev_open) : l'installeur doit toujours
    obtenir un 200 public — seul l'enrichissement est refusé."""
    with TestClient(create_app(_settings(db_url, dev_open_admin=False))) as c:
        r = c.get("/api/status")
        assert r.status_code == 200
        assert ENRICHED_FIELDS.isdisjoint(r.json().keys())


def test_status_reflects_runtime_polling_overrides(secured_client):
    """Env dit polling OFF/60s ; l'UI (config runtime) dit ON/120s → status suit le runtime."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    app = secured_client.app
    with db.session_scope() as s:
        cfg = RuntimeConfigService(s, app.state.secrets_box, app.state.settings)
        cfg.set("polling_enabled", "true")
        cfg.set("polling_interval_seconds", "120")

    secured_client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    body = secured_client.get("/api/status").json()
    assert body["polling_enabled"] is True
    assert body["polling_interval_seconds"] == 120


def test_status_and_metrics_reflect_runtime_cost_cap(db_url):
    """Le plafond affiché (status + /api/metrics) est la valeur RUNTIME lue par le moteur
    (api/runtime.py), pas la seule valeur d'environnement."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    with TestClient(create_app(_settings(db_url, dev_open_admin=True))) as c:
        with db.session_scope() as s:
            RuntimeConfigService(s, c.app.state.secrets_box, c.app.state.settings).set(
                "cost_cap_eur_per_day", "9.5"
            )
        assert c.get("/api/status").json()["cost_cap_eur_per_day"] == 9.5
        assert c.get("/api/metrics").json()["cost_cap_eur_per_day"] == 9.5


# ── Bloc `last_poll` : diagnostic du dernier cycle (audit fiabilité 2026-08) ──


def test_last_poll_is_never_exposed_to_anonymous(secured_client):
    """Volumétrie et message d'erreur = reconnaissance offerte : le bloc reste réservé
    à la session admin, comme le reste de la réponse enrichie."""
    assert "last_poll" not in secured_client.get("/api/status").json()


def test_last_poll_says_explicitly_that_no_cycle_ever_ran(secured_client):
    """« Aucun cycle n'a jamais tourné » doit être un état EXPLICITE : c'est le symptôme
    n°1 (worker « En marche » alors que rien ne s'exécute)."""
    secured_client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    block = secured_client.get("/api/status").json()["last_poll"]
    assert block["has_run"] is False
    assert block["run_at"] is None and block["error_message"] is None
    assert block["fetched"] == 0 and block["processed"] == 0


def test_last_poll_reflects_the_persisted_cycle(secured_client):
    """`PollStats` était jeté après un log : ces compteurs répondent enfin à
    « pourquoi aucun ticket n'est trié ? » sans ouvrir `docker logs`."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    app = secured_client.app
    with db.session_scope() as s:
        cfg = RuntimeConfigService(s, app.state.secrets_box, app.state.settings)
        cfg.set("poll_last_run_at", "2026-08-08T19:42:03+00:00")
        cfg.set("poll_last_fetched", "12")
        cfg.set("poll_last_processed", "3")
        cfg.set("poll_last_skipped_done", "9")
        cfg.set("poll_last_skipped_scope", "0")
        cfg.set("poll_last_errors", "1")
        cfg.set("poll_last_error_message", "Référentiels GLPI indisponibles: timeout")

    secured_client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    block = secured_client.get("/api/status").json()["last_poll"]
    assert block["has_run"] is True and block["run_at"].startswith("2026-08-08")
    assert block["fetched"] == 12 and block["processed"] == 3
    assert block["skipped_done"] == 9 and block["skipped_scope"] == 0
    assert block["errors"] == 1
    assert "Référentiels GLPI indisponibles" in block["error_message"]


def test_last_poll_error_message_is_bounded(secured_client):
    """Un champ de diagnostic ne doit jamais devenir un canal de fuite : borné à 300."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    app = secured_client.app
    with db.session_scope() as s:
        cfg = RuntimeConfigService(s, app.state.secrets_box, app.state.settings)
        cfg.set("poll_last_run_at", "2026-08-08T19:42:03+00:00")
        cfg.set("poll_last_error_message", "A" * 5000)

    secured_client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    block = secured_client.get("/api/status").json()["last_poll"]
    assert len(block["error_message"]) <= 301  # +1 pour l'ellipse
