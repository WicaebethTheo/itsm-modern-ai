"""Création du compte administrateur à la première visite (`POST /api/auth/setup`).

Contrat servi au frontend (`frontend/src/pages/Setup.tsx`) :
    200 → { authenticated, auth_configured, setup_required } et session ouverte
    409 → detail.code = "already_configured"
    422 → detail.code = "invalid_password" | "invalid_email"
    429 → detail.code = "too_many_attempts" + en-tête Retry-After
"""

from __future__ import annotations

import logging

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.api.security import HASH_KEY, MIN_ADMIN_CHARS
from itsm_modern_ai.config.settings import Settings

EMAIL = "admin@exemple.fr"
MOT_DE_PASSE = "s3cret-pilote"


def _settings(db_url, tmp_path, **kw) -> Settings:
    kw.setdefault("session_https_only", False)  # TestClient = http → cookie non-Secure
    kw.setdefault("dev_open_admin", False)
    # `master_key` surchargeable : un second démarrage sur la MÊME base doit rejouer la
    # même clé, sinon le hash admin devient illisible et l'instance se croit vierge.
    kw.setdefault("master_key", Fernet.generate_key().decode())
    return Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=db_url,
        polling_enabled=False,
        frontend_dist=str(tmp_path / "dist"),
        **kw,
    )


@pytest.fixture
def vierge(db_url, tmp_path):
    """Instance neuve : aucun compte, donc revendicable — l'état de la première visite."""
    with TestClient(create_app(_settings(db_url, tmp_path))) as c:
        yield c


# ── Le parcours nominal ───────────────────────────────────────────────────────
def test_une_instance_vierge_reclame_son_installation(vierge):
    body = vierge.get("/api/auth/status").json()
    assert body == {"authenticated": False, "auth_configured": False, "setup_required": True}


def test_la_creation_ouvre_la_session_immediatement(vierge):
    """Le front n'affiche PAS d'écran de connexion après la création : il va au tableau."""
    r = vierge.post("/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE})
    assert r.status_code == 200
    assert r.json() == {"authenticated": True, "auth_configured": True, "setup_required": False}
    assert vierge.cookies.get("session"), "la création doit poser un cookie de session"
    # Session réellement utilisable sur une route protégée (pas seulement un booléen).
    assert vierge.get("/api/decisions").status_code == 200


def test_le_compte_est_stocke_hache_et_l_email_en_clair(vierge):
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services.runtime_config import RuntimeConfigService

    vierge.post(
        "/api/auth/setup",
        json={"email": "  Admin@Exemple.FR ", "password": MOT_DE_PASSE, "display_name": "Théo"},
    )
    with db.session_scope() as s:
        cfg = RuntimeConfigService(s, vierge.app.state.secrets_box, vierge.app.state.settings)
        stocke = cfg.get_secret(HASH_KEY)
        assert stocke and stocke.startswith("$argon2") and MOT_DE_PASSE not in stocke
        assert cfg.admin_email() == EMAIL  # forme canonique
        assert cfg.admin_display_name() == "Théo"


def test_la_connexion_fonctionne_apres_creation(vierge):
    vierge.post("/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE})
    vierge.post("/api/auth/logout")
    vierge.cookies.clear()
    assert vierge.get("/api/decisions").status_code == 401

    r = vierge.post("/api/auth/login", json={"email": EMAIL, "password": MOT_DE_PASSE})
    assert r.status_code == 200 and r.json()["authenticated"] is True
    assert vierge.get("/api/decisions").status_code == 200


def test_la_connexion_ignore_la_casse_de_l_email(vierge, creer_compte_admin):
    creer_compte_admin(vierge, email=EMAIL, password=MOT_DE_PASSE)
    r = vierge.post("/api/auth/login", json={"email": " ADMIN@Exemple.FR ", "password": MOT_DE_PASSE})
    assert r.status_code == 200


# ── Fail-closed : un compte existe déjà ───────────────────────────────────────
def test_une_seconde_creation_est_refusee_sans_toucher_au_compte(vierge):
    vierge.post("/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE})
    vierge.post("/api/auth/logout")
    vierge.cookies.clear()

    r = vierge.post(
        "/api/auth/setup", json={"email": "pirate@exemple.fr", "password": "pirate-pass-1"}
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "already_configured"
    assert not vierge.cookies.get("session")  # aucune session offerte au passage

    # Le compte d'origine est intact : l'usurpateur ne peut pas s'y connecter, le vrai si.
    assert vierge.post(
        "/api/auth/login", json={"email": "pirate@exemple.fr", "password": "pirate-pass-1"}
    ).status_code == 401
    assert vierge.post(
        "/api/auth/login", json={"email": EMAIL, "password": MOT_DE_PASSE}
    ).status_code == 200


def test_le_statut_ne_reclame_plus_l_installation_une_fois_le_compte_cree(vierge):
    vierge.post("/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE})
    body = vierge.get("/api/auth/status").json()
    assert body["auth_configured"] is True and body["setup_required"] is False


# ── Validation ────────────────────────────────────────────────────────────────
def test_un_mot_de_passe_trop_court_est_refuse_en_422(vierge):
    r = vierge.post(
        "/api/auth/setup", json={"email": EMAIL, "password": "x" * (MIN_ADMIN_CHARS - 1)}
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_password"
    # L'instance reste vierge : le prochain essai doit pouvoir créer le compte.
    assert vierge.get("/api/auth/status").json()["setup_required"] is True


def test_une_adresse_invalide_est_refusee_en_422(vierge):
    r = vierge.post("/api/auth/setup", json={"email": "pas-une-adresse", "password": MOT_DE_PASSE})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_email"
    assert vierge.get("/api/auth/status").json()["setup_required"] is True


def test_la_longueur_minimale_exacte_passe(vierge):
    """Borne exacte : MIN_ADMIN_CHARS caractères sont acceptés (pas de décalage d'un cran)."""
    r = vierge.post(
        "/api/auth/setup", json={"email": EMAIL, "password": "a" * MIN_ADMIN_CHARS}
    )
    assert r.status_code == 200


# ── L'email ne fuite jamais avant authentification ────────────────────────────
def test_l_email_n_apparait_sur_aucune_reponse_publique(vierge, creer_compte_admin):
    """L'adresse est la moitié des identifiants : un anonyme ne doit pas l'obtenir."""
    creer_compte_admin(vierge, email=EMAIL, password=MOT_DE_PASSE)
    for chemin in ("/api/auth/status", "/api/status", "/health"):
        r = vierge.get(chemin)
        assert EMAIL not in r.text, f"{chemin} divulgue l'adresse du compte"
    # Refus de connexion et de seconde installation : muets eux aussi.
    assert EMAIL not in vierge.post(
        "/api/auth/login", json={"email": "inconnu@exemple.fr", "password": "x" * 12}
    ).text
    assert EMAIL not in vierge.post(
        "/api/auth/setup", json={"email": "pirate@exemple.fr", "password": "pirate-pass-1"}
    ).text


def test_le_refus_ne_distingue_pas_email_inconnu_et_mot_de_passe_faux(vierge, creer_compte_admin):
    creer_compte_admin(vierge, email=EMAIL, password=MOT_DE_PASSE)
    inconnu = vierge.post(
        "/api/auth/login", json={"email": "inconnu@exemple.fr", "password": MOT_DE_PASSE}
    )
    faux = vierge.post("/api/auth/login", json={"email": EMAIL, "password": "mauvais-mot-passe"})
    assert inconnu.status_code == faux.status_code == 401
    assert inconnu.json() == faux.json()  # même code, même message : aucun oracle


# ── Limiteur de tentatives (le même que le login) ─────────────────────────────
def test_le_setup_est_soumis_au_limiteur_de_tentatives(db_url, tmp_path):
    """Sans ça, la création offre un point de martèlement public NON compté."""
    with TestClient(create_app(_settings(db_url, tmp_path, login_max_attempts=3))) as c:
        c.post("/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE})
        c.cookies.clear()
        for _ in range(3):  # 3 refus (compte déjà créé) → le seuil est franchi
            assert c.post(
                "/api/auth/setup", json={"email": "pirate@exemple.fr", "password": "pirate-pass-1"}
            ).status_code == 409
        bloque = c.post(
            "/api/auth/setup", json={"email": "pirate@exemple.fr", "password": "pirate-pass-1"}
        )
        assert bloque.status_code == 429
        assert bloque.json()["detail"]["code"] == "too_many_attempts"
        assert int(bloque.headers["Retry-After"]) > 0


def test_les_echecs_de_setup_bloquent_aussi_le_login(db_url, tmp_path):
    """Même limiteur, même clé : marteler `setup` ne contourne pas le blocage du login."""
    with TestClient(create_app(_settings(db_url, tmp_path, login_max_attempts=3))) as c:
        c.post("/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE})
        c.post("/api/auth/logout")
        c.cookies.clear()
        for _ in range(3):
            c.post("/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE})
        assert c.post(
            "/api/auth/login", json={"email": EMAIL, "password": MOT_DE_PASSE}
        ).status_code == 429


def test_la_creation_reussie_efface_le_compteur_d_echecs(db_url, tmp_path):
    with TestClient(create_app(_settings(db_url, tmp_path, login_max_attempts=3))) as c:
        for _ in range(2):  # sous le seuil : mot de passe trop court
            assert c.post("/api/auth/setup", json={"email": EMAIL, "password": "court"}).status_code == 422
        assert c.post(
            "/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE}
        ).status_code == 200
        c.post("/api/auth/logout")
        c.cookies.clear()
        # Compteur remis à zéro : deux nouveaux échecs ne bloquent pas la connexion.
        for _ in range(2):
            c.post("/api/auth/login", json={"email": EMAIL, "password": "faux-mot-de-passe"})
        assert c.post(
            "/api/auth/login", json={"email": EMAIL, "password": MOT_DE_PASSE}
        ).status_code == 200


# ── Avertissement de démarrage (risque de revendication, assumé) ──────────────
class _Recorder(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


def test_le_demarrage_previent_que_l_instance_est_revendicable(db_url, tmp_path):
    """Le handler est posé APRÈS `create_app` : celui-ci reconfigure le logging et
    détacherait le handler de capture de pytest (d'où ce recorder maison)."""
    app = create_app(_settings(db_url, tmp_path))
    recorder = _Recorder()
    logging.getLogger("itsm.security").addHandler(recorder)
    try:
        with TestClient(app) as c:  # le lifespan tourne à l'entrée du contexte
            assert any("REVENDICABLE" in m for m in recorder.messages)
            recorder.messages.clear()
            # La création laisse une trace explicite, IP comprise.
            c.post("/api/auth/setup", json={"email": EMAIL, "password": MOT_DE_PASSE})
            assert any("compte administrateur CRÉÉ depuis" in m for m in recorder.messages)
    finally:
        logging.getLogger("itsm.security").removeHandler(recorder)


def test_aucun_avertissement_au_demarrage_si_le_compte_existe(db_url, tmp_path, creer_compte_admin):
    settings = _settings(db_url, tmp_path)
    with TestClient(create_app(settings)) as c:
        creer_compte_admin(c, email=EMAIL, password=MOT_DE_PASSE)

    # Second démarrage sur la MÊME base : plus rien à annoncer.
    app = create_app(_settings(db_url, tmp_path, master_key=settings.master_key))
    recorder = _Recorder()
    logging.getLogger("itsm.security").addHandler(recorder)
    try:
        with TestClient(app):
            assert not any("REVENDICABLE" in m for m in recorder.messages)
    finally:
        logging.getLogger("itsm.security").removeHandler(recorder)
