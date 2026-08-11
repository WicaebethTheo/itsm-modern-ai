"""Révocation de session + politique de mot de passe (durcissement audit 2026-08).

Deux défauts PROUVÉS, corrigés ici :
1. le cookie signé ne portait que `{"authenticated": true}` → il survivait au logout ET au
   changement de mot de passe (rejeu mesuré : 200). La seule parade était de changer
   MASTER_KEY, ce qui rend illisibles TOUS les secrets et verrouille la console ;
2. la politique de longueur n'était appliquée que par la CLI. Elle est désormais portée par
   `api/security.MIN_ADMIN_CHARS` et appliquée par le SEUL chemin de création restant —
   `POST /api/auth/setup` — puisque l'amorçage par variable d'environnement a disparu.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings

EMAIL = "admin@exemple.fr"
PASSWORD = "s3cret-pilote"


def _settings(db_url, tmp_path, **kw) -> Settings:
    kw.setdefault("session_https_only", False)  # TestClient = http → cookie non-Secure
    kw.setdefault("dev_open_admin", False)
    return Settings(
        _env_file=None,
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        frontend_dist=str(tmp_path / "dist"),
        **kw,
    )


@pytest.fixture
def secured(db_url, tmp_path, creer_compte_admin):
    with TestClient(create_app(_settings(db_url, tmp_path))) as c:
        creer_compte_admin(c, email=EMAIL, password=PASSWORD)
        yield c


def _login_and_capture_cookie(client) -> str:
    r = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200
    cookie = client.cookies.get("session")
    assert cookie, "la session doit poser un cookie signé"
    return cookie


# ── 1. Révocation ─────────────────────────────────────────────────────────────
def test_cookie_replay_after_logout_is_rejected(secured):
    """Le cookie capturé AVANT le logout ne doit plus rien ouvrir après (rejeu = 401)."""
    stolen = _login_and_capture_cookie(secured)
    assert secured.get("/api/decisions").status_code == 200

    secured.post("/api/auth/logout")
    # Rejeu : on repose exactement le cookie exfiltré (ce que ferait un attaquant).
    secured.cookies.set("session", stolen)
    assert secured.get("/api/decisions").status_code == 401
    # Et l'endpoint « suis-je connecté ? » ne doit pas dire l'inverse de l'API.
    secured.cookies.set("session", stolen)
    assert secured.get("/api/auth/status").json()["authenticated"] is False


def test_cookie_replay_after_password_change_is_rejected(secured):
    """Changer le mot de passe admin invalide les sessions déjà émises."""
    from itsm_modern_ai.admin_setup import set_admin_password
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    stolen = _login_and_capture_cookie(secured)
    assert secured.get("/api/decisions").status_code == 200

    with db.session_scope() as s:
        cfg = RuntimeConfigService(
            s, secured.app.state.secrets_box, secured.app.state.settings
        )
        set_admin_password(cfg, "nouveau-mot-de-passe", force=True)

    secured.cookies.set("session", stolen)
    assert secured.get("/api/decisions").status_code == 401
    # Le nouveau mot de passe fonctionne, et rouvre une session valide (on repart d'un
    # bocal à cookies propre : le cookie révoqué a été reposé à la main juste avant).
    secured.cookies.clear()
    assert secured.post(
        "/api/auth/login", json={"email": EMAIL, "password": "nouveau-mot-de-passe"}
    ).status_code == 200
    assert secured.get("/api/decisions").status_code == 200


def test_anonymous_logout_does_not_revoke_admin_session(db_url, tmp_path, creer_compte_admin):
    """`/api/auth/logout` est public : un anonyme ne doit pas pouvoir déconnecter l'admin.

    Sinon la révocation devient un déni de service trivial (marteler le POST).
    """
    app = create_app(_settings(db_url, tmp_path))
    with TestClient(app) as admin, TestClient(app) as anon:
        creer_compte_admin(admin, email=EMAIL, password=PASSWORD)
        assert admin.post(
            "/api/auth/login", json={"email": EMAIL, "password": PASSWORD}
        ).status_code == 200
        assert anon.post("/api/auth/logout").status_code == 200  # sans session
        assert admin.get("/api/decisions").status_code == 200  # l'admin reste connecté


def test_dev_open_admin_still_works_without_session(db_url, tmp_path):
    """Non-régression : le mode labo (aucun mot de passe + dev_open_admin) reste ouvert."""
    with TestClient(create_app(_settings(db_url, tmp_path, dev_open_admin=True))) as c:
        assert c.get("/api/decisions").status_code == 200
        assert c.get("/api/auth/status").json()["authenticated"] is True


# ── 2. Politique de mot de passe appliquée par la SEULE porte de création ──────
def test_un_mot_de_passe_trop_court_laisse_l_instance_fermee(db_url, tmp_path):
    """Un mot de passe sous le minimum est REFUSÉ : rien n'est créé, l'accès reste fermé."""
    with TestClient(create_app(_settings(db_url, tmp_path))) as c:
        r = c.post("/api/auth/setup", json={"email": EMAIL, "password": "x"})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_password"
        # Le mot de passe d'un caractère n'ouvre RIEN (il ouvrait un 200 avant).
        assert c.post("/api/auth/login", json={"email": EMAIL, "password": "x"}).status_code == 401
        body = c.get("/api/auth/status").json()
        assert body["auth_configured"] is False and body["authenticated"] is False
        # Fail-closed : les routes d'admin restent fermées.
        assert c.get("/api/decisions").status_code == 401


def test_un_mot_de_passe_refuse_n_est_pas_stocke(db_url, tmp_path):
    """Rien ne doit être écrit en base : sinon le compte serait créé à moitié, et la
    seconde tentative se heurterait à un 409 sur un compte inutilisable."""
    from itsm_modern_ai.api.security import HASH_KEY
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    with TestClient(create_app(_settings(db_url, tmp_path))) as c:
        c.post("/api/auth/setup", json={"email": EMAIL, "password": "court"})
        with db.session_scope() as s:
            cfg = RuntimeConfigService(s, c.app.state.secrets_box, c.app.state.settings)
            assert cfg.is_secret_set(HASH_KEY) is False
            assert cfg.admin_email() is None


def test_la_longueur_minimale_exacte_est_acceptee(db_url, tmp_path):
    """Borne exacte : MIN_ADMIN_CHARS caractères passent (pas de décalage d'un cran)."""
    from itsm_modern_ai.api.security import MIN_ADMIN_CHARS

    pw = "a" * MIN_ADMIN_CHARS
    with TestClient(create_app(_settings(db_url, tmp_path))) as c:
        assert c.post("/api/auth/setup", json={"email": EMAIL, "password": pw}).status_code == 200
        c.post("/api/auth/logout")
        c.cookies.clear()
        assert c.post("/api/auth/login", json={"email": EMAIL, "password": pw}).status_code == 200
