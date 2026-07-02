"""Epic 4 : journal (FR-20), export CSV (FR-21), auth locale (FR-24)."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain.models import Decision, TriageOutcome, TriageReason


def _seed_decision():
    from itsm_modern_ai.persistence import db, journal

    outcome = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        return journal.record_decision(s, 100, outcome, glpi_link="http://glpi/100")


def _settings(tmp_path, **kw) -> Settings:
    kw.setdefault("dev_open_admin", True)  # défaut test : admin ouvert sans mot de passe
    kw.setdefault("session_https_only", False)  # TestClient = http → cookie non-Secure
    return Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=f"sqlite:///{tmp_path / 'a.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


# ── Auth NON configurée (pilote ouvert) ──────────────────────────────────────
@pytest.fixture
def open_client(tmp_path):
    with TestClient(create_app(_settings(tmp_path))) as c:
        yield c


def test_journal_open_when_no_admin_password(open_client):
    did = _seed_decision()
    r = open_client.get("/api/decisions")
    assert r.status_code == 200 and r.json()[0]["ticket_id"] == 100
    # annotation
    r2 = open_client.patch(f"/api/decisions/{did}/annotation", json={"annotation": "juste"})
    assert r2.json()["annotation"] == "juste"


def test_decisions_resolve_names_and_urgency(open_client):
    """Le journal enrichit chaque décision : noms (cat/tech) résolus + urgence dérivée."""
    from itsm_modern_ai.domain.models import Referentials
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services import referentials

    _seed_decision()  # category=1, priority=3, technician_id=11
    with db.session_scope() as s:
        referentials.sync(
            s, Referentials(categories={1: "Compte"}, technicians={11: "Marc Lefèvre"})
        )
    entry = open_client.get("/api/decisions").json()[0]
    assert entry["technician_name"] == "Marc Lefèvre"
    assert entry["category_name"] == "Compte"
    assert entry["urgency"] == 3  # min(priority=3, 5)
    assert entry["group_name"] is None


def test_journal_link_rebuilt_from_runtime_glpi_url(open_client):
    """Régression : le SUJET du Journal doit être cliquable en prod.

    En prod, l'URL GLPI est posée via l'UI (config runtime), pas dans `.env`. Le lien
    front du Ticket doit être reconstruit à la lecture depuis cette URL — y compris pour
    une décision dont le lien figé était vide (cas du ticket triagé avant configuration).
    """
    from itsm_modern_ai.persistence import db, journal
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    # Décision enregistrée AVEC un lien figé vide (reproduit le bug de prod).
    outcome = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        journal.record_decision(s, 100, outcome, glpi_link="")

    # Avant config GLPI : lien absent (repli sur le lien stocké, vide ici).
    assert open_client.get("/api/decisions").json()[0]["glpi_link"] == ""

    # L'admin configure l'URL GLPI via l'UI (config runtime).
    box = open_client.app.state.secrets_box
    settings = open_client.app.state.settings
    with db.session_scope() as s:
        RuntimeConfigService(s, box, settings).set(
            "glpi_base_url", "https://glpi.local/apirest.php"
        )

    # Le lien est désormais reconstruit → sujet cliquable, même pour la décision déjà loggée.
    entry = open_client.get("/api/decisions").json()[0]
    assert entry["glpi_link"] == "https://glpi.local/front/ticket.form.php?id=100"


def test_glpi_reset_clears_connection(open_client):
    """Le bouton « Réinitialiser » efface toute la connexion GLPI (legacy + V2)."""
    open_client.post(
        "/api/config",
        json={
            "glpi_base_url": "https://glpi.example.com/apirest.php",
            "glpi_api_version": "v2",
            "glpi_v2_base_url": "https://glpi.example.com/api.php/v2.3",
            "glpi_oauth_client_id": "cid",
            "glpi_user_token": "tok",
            "glpi_oauth_client_secret": "secret",
        },
    )
    assert open_client.post("/api/glpi/reset").json()["ok"] is True
    cfg = open_client.get("/api/config").json()
    assert (cfg["glpi_base_url"] or "") == "" and (cfg["glpi_v2_base_url"] or "") == ""
    assert cfg["glpi_api_version"] == "legacy"  # repassé au défaut sûr
    assert (cfg["glpi_oauth_client_id"] or "") == ""
    assert cfg["glpi_user_token_set"] is False and cfg["glpi_oauth_client_secret_set"] is False


def test_export_csv_open(open_client):
    _seed_decision()
    r = open_client.get("/api/export/decisions.csv")
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    assert "ticket_id" in r.text


# ── Auth configurée ───────────────────────────────────────────────────────────
@pytest.fixture
def secured_client(tmp_path):
    with TestClient(create_app(_settings(tmp_path, admin_password="s3cret"))) as c:
        yield c


def test_protected_without_login_is_401(secured_client):
    assert secured_client.get("/api/decisions").status_code == 401
    assert secured_client.post("/api/config", json={"llm_model": "x"}).status_code == 401
    assert secured_client.get("/api/export/decisions.csv").status_code == 401


def test_login_then_access(secured_client):
    assert secured_client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    ok = secured_client.post("/api/auth/login", json={"password": "s3cret"})
    assert ok.status_code == 200 and ok.json()["authenticated"] is True
    # session active → accès autorisé
    _seed_decision()
    assert secured_client.get("/api/decisions").status_code == 200
    assert secured_client.post("/api/config", json={"llm_model": "mistral-small-latest"}).status_code == 200
    # logout → de nouveau refusé
    secured_client.post("/api/auth/logout")
    assert secured_client.get("/api/decisions").status_code == 401


def test_auth_status_reports_configured(secured_client):
    body = secured_client.get("/api/auth/status").json()
    assert body["auth_configured"] is True and body["authenticated"] is False


def test_auth_status_reflects_dev_open_access(tmp_path):
    # `authenticated` reflète les règles d'accès de require_auth (dev_open inclus) :
    # le frontend s'y fie seul — sinon boucle de redirection en fail-closed.
    with TestClient(create_app(_settings(tmp_path))) as c:  # dev_open, non configuré
        body = c.get("/api/auth/status").json()
        assert body["auth_configured"] is False and body["authenticated"] is True


def test_auth_status_fail_closed_not_authenticated(tmp_path):
    with TestClient(create_app(_settings(tmp_path, dev_open_admin=False))) as c:
        body = c.get("/api/auth/status").json()
        assert body["auth_configured"] is False and body["authenticated"] is False


# ── Rate-limiting du login (FR-24 durci) ─────────────────────────────────────
def test_login_rate_limited_after_repeated_failures(tmp_path):
    # Seuil bas pour déclencher vite ; fenêtre/blocage longs pour rester bloqué.
    settings = _settings(tmp_path, admin_password="s3cret", login_max_attempts=3)
    with TestClient(create_app(settings)) as c:
        # 3 échecs → le 3e franchit le seuil (toujours 401, mais arme le blocage).
        for _ in range(3):
            assert c.post("/api/auth/login", json={"password": "nope"}).status_code == 401
        # 4e tentative : bloquée même avec le bon mot de passe.
        blocked = c.post("/api/auth/login", json={"password": "s3cret"})
        assert blocked.status_code == 429
        assert "Retry-After" in blocked.headers
        assert blocked.json()["detail"]["code"] == "too_many_attempts"


def test_login_success_resets_counter(tmp_path):
    settings = _settings(tmp_path, admin_password="s3cret", login_max_attempts=3)
    with TestClient(create_app(settings)) as c:
        # 2 échecs (sous le seuil), puis un succès qui réinitialise le compteur.
        c.post("/api/auth/login", json={"password": "nope"})
        c.post("/api/auth/login", json={"password": "nope"})
        assert c.post("/api/auth/login", json={"password": "s3cret"}).status_code == 200
        c.post("/api/auth/logout")
        # Le compteur est reparti de zéro : 2 nouveaux échecs ne bloquent pas.
        c.post("/api/auth/login", json={"password": "nope"})
        c.post("/api/auth/login", json={"password": "nope"})
        assert c.post("/api/auth/login", json={"password": "s3cret"}).status_code == 200


# ── Fail-closed : aucun mot de passe + dev_open_admin=False → refus (durcissement) ──
def test_admin_fail_closed_when_no_password_and_not_dev_open(tmp_path):
    settings = _settings(tmp_path, dev_open_admin=False)  # ni password ni ouverture explicite
    with TestClient(create_app(settings)) as c:
        # Routes protégées : refus systématique (401), pas d'accès « ouvert ».
        assert c.get("/api/decisions").status_code == 401
        assert c.post("/api/config", json={"llm_model": "x"}).status_code == 401
        assert c.get("/api/export/decisions.csv").status_code == 401


# ── Fail-safe déchiffrement : hash admin illisible (MASTER_KEY incohérente) ──────
def test_login_does_not_500_when_admin_hash_unreadable(tmp_path):
    """Si le hash admin a été chiffré avec une autre MASTER_KEY (rotation/perte de clé),
    le login NE doit PAS crasher en 500 : il retombe en fail-closed 401 clair."""
    from itsm_modern_ai.adapters.secrets.encrypted import FernetSecretsBox
    from itsm_modern_ai.api import security
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    settings = _settings(tmp_path, dev_open_admin=False)
    app = create_app(settings)
    with TestClient(app) as c:
        # Stocke un hash admin chiffré avec une clé DIFFÉRENTE de celle de l'app.
        foreign_box = FernetSecretsBox(master_key=Fernet.generate_key().decode())
        with db.session_scope() as s:
            RuntimeConfigService(s, foreign_box, settings).set_secret(
                security.HASH_KEY, "fake-argon2-hash"
            )
        # Login : le hash est illisible → 401 (fail-closed), jamais 500.
        r = c.post("/api/auth/login", json={"password": "whatever"})
        assert r.status_code == 401
        # Les routes protégées restent refusées proprement (pas de 500).
        assert c.get("/api/decisions").status_code == 401


def test_status_counters_present(open_client):
    body = open_client.get("/api/status").json()
    assert "llm_calls_total" in body and "cost_eur_last_24h" in body
    assert body["cost_cap_eur_per_day"] == 5.0
