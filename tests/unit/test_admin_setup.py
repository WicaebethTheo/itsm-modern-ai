"""Compte administrateur (FR-24) : hash stocké, jamais de clair, identité, CLI de secours."""

from __future__ import annotations

import io
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from cryptography.fernet import Fernet
from sqlmodel import Session

from itsm_modern_ai.adapters.secrets.encrypted import FernetSecretsBox
from itsm_modern_ai.admin_setup import MIN_LEN, AdminSetupError, main, set_admin_password
from itsm_modern_ai.api import security
from itsm_modern_ai.api.security import HASH_KEY
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.persistence import db
from itsm_modern_ai.services.runtime_config import RuntimeConfigService

EMAIL = "admin@exemple.fr"


@pytest.fixture
def cfg(temp_db) -> Iterator[RuntimeConfigService]:
    """Service de config branché sur le schéma jetable du test (`temp_db`).

    La session est ouverte en `with` : une session laissée ouverte garde une connexion
    « idle in transaction », donc un verrou sur les tables, et le `DROP SCHEMA` de fin
    de test s'y heurterait.
    """
    settings = Settings(_env_file=None, master_key=Fernet.generate_key().decode())
    box = FernetSecretsBox(master_key=settings.master_key)
    with Session(db.get_engine()) as session:
        yield RuntimeConfigService(session, box, settings)


# ── Stockage du compte ────────────────────────────────────────────────────────
def test_le_mot_de_passe_est_stocke_hache_jamais_en_clair(cfg):
    set_admin_password(cfg, "s3cret-pass", email=EMAIL)
    assert cfg.is_secret_set(HASH_KEY)
    stored = cfg.get_secret(HASH_KEY)
    assert stored and "s3cret-pass" not in stored  # hash Argon2, pas le clair
    assert stored.startswith("$argon2")


def test_l_email_est_stocke_en_forme_canonique(cfg):
    set_admin_password(cfg, "s3cret-pass", email="  Admin@Exemple.FR  ")
    assert cfg.admin_email() == EMAIL


def test_le_nom_affiche_est_optionnel_et_conserve(cfg):
    set_admin_password(cfg, "s3cret-pass", email=EMAIL, display_name="  Théo, DSI  ")
    assert cfg.admin_display_name() == "Théo, DSI"


def test_un_mot_de_passe_trop_court_est_refuse(cfg):
    with pytest.raises(AdminSetupError) as exc:
        set_admin_password(cfg, "x" * (MIN_LEN - 1), email=EMAIL)
    assert exc.value.code == "invalid_password"
    assert not cfg.is_secret_set(HASH_KEY)


@pytest.mark.parametrize("invalide", ["", "pas-une-adresse", "a@b", "a b@c.fr", "@exemple.fr"])
def test_une_adresse_invalide_est_refusee_sans_rien_ecrire(cfg, invalide):
    """Refus AVANT la moindre écriture : sinon un hash orphelin bloquerait la 2e tentative."""
    with pytest.raises(AdminSetupError) as exc:
        set_admin_password(cfg, "s3cret-pass", email=invalide)
    assert exc.value.code == "invalid_email"
    assert not cfg.is_secret_set(HASH_KEY) and cfg.admin_email() is None


def test_une_adresse_trop_longue_est_refusee(cfg):
    with pytest.raises(AdminSetupError):
        set_admin_password(cfg, "s3cret-pass", email="a" * 250 + "@exemple.fr")


def test_le_remplacement_est_refuse_sans_force(cfg):
    set_admin_password(cfg, "first-pass", email=EMAIL)
    with pytest.raises(AdminSetupError) as exc:
        set_admin_password(cfg, "second-pass", email="autre@exemple.fr")
    assert exc.value.code == "already_configured"
    # Le compte en place n'a pas bougé (ni mot de passe, ni adresse).
    assert cfg.admin_email() == EMAIL
    assert security.verify_login(cfg, EMAIL, "first-pass") is True


def test_force_remplace_le_compte(cfg):
    set_admin_password(cfg, "first-pass", email=EMAIL)
    h1 = cfg.get_secret(HASH_KEY)
    set_admin_password(cfg, "second-pass", email="autre@exemple.fr", force=True)
    assert cfg.get_secret(HASH_KEY) != h1
    assert cfg.admin_email() == "autre@exemple.fr"


def test_toute_rotation_revoque_les_sessions(cfg):
    """Toute rotation de mot de passe doit invalider les sessions émises (révocation)."""
    before = cfg.session_version()
    set_admin_password(cfg, "first-pass", email=EMAIL)
    after_first = cfg.session_version()
    set_admin_password(cfg, "second-pass", email=EMAIL, force=True)
    assert after_first > before and cfg.session_version() > after_first


# ── Vérification des identifiants ─────────────────────────────────────────────
def test_la_connexion_ignore_la_casse_et_les_espaces_de_bord(cfg):
    set_admin_password(cfg, "s3cret-pass", email=EMAIL)
    assert security.verify_login(cfg, "  ADMIN@Exemple.fr ", "s3cret-pass") is True


def test_un_email_inconnu_ne_connecte_pas(cfg):
    set_admin_password(cfg, "s3cret-pass", email=EMAIL)
    assert security.verify_login(cfg, "inconnu@exemple.fr", "s3cret-pass") is False
    assert security.verify_login(cfg, EMAIL, "mauvais-pass") is False


class _HasherEspion:
    """Compte les vérifications Argon2 réellement demandées."""

    def __init__(self) -> None:
        self.verifications: list[str] = []

    def hash(self, plaintext: str) -> str:
        return "$argon2$factice"

    def verify(self, plaintext: str, hash_: str) -> bool:
        self.verifications.append(hash_)
        return False


def test_le_hash_est_verifie_meme_quand_l_email_est_inconnu(cfg, monkeypatch):
    """Pas d'oracle temporel : un email inconnu paie la MÊME vérification qu'un email connu.

    Sans ça, le refus immédiat contre ~50 ms d'Argon2 suffirait à énumérer les adresses au
    chronomètre — et le message unique de la route ne servirait plus à rien.
    """
    set_admin_password(cfg, "s3cret-pass", email=EMAIL)
    espion = _HasherEspion()
    monkeypatch.setattr(security, "_hasher", espion)
    assert security.verify_login(cfg, "inconnu@exemple.fr", "peu-importe") is False
    assert len(espion.verifications) == 1  # vérifié malgré l'email inconnu


def test_aucun_compte_configure_paie_quand_meme_une_verification(cfg, monkeypatch):
    espion = _HasherEspion()
    monkeypatch.setattr(security, "_hasher", espion)
    monkeypatch.setattr(security, "_dummy_hash_cache", None)
    assert security.verify_login(cfg, EMAIL, "peu-importe") is False
    assert len(espion.verifications) == 1


def test_un_hash_illisible_ne_leve_pas_d_exception(cfg):
    """Hash déchiffrable mais de format inconnu : refus net, jamais une 500."""
    cfg.set_secret(HASH_KEY, "pas-un-hash-argon2")
    cfg.set_admin_identity(EMAIL)
    assert security.verify_login(cfg, EMAIL, "s3cret-pass") is False


# ── Avertissement de démarrage (fenêtre de revendication assumée) ──────────────
def test_avertissement_bruyant_tant_qu_aucun_compte_n_existe(cfg, caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="itsm.security"):
        assert security.warn_if_setup_required(cfg) is True
    message = " ".join(r.getMessage() for r in caplog.records)
    assert "REVENDICABLE" in message and "AUCUN COMPTE ADMINISTRATEUR" in message


def test_l_avertissement_disparait_une_fois_le_compte_cree(cfg, caplog):
    import logging

    set_admin_password(cfg, "s3cret-pass", email=EMAIL)
    with caplog.at_level(logging.WARNING, logger="itsm.security"):
        assert security.warn_if_setup_required(cfg) is False
    assert not [r for r in caplog.records if "REVENDICABLE" in r.getMessage()]


# ── CLI de récupération ───────────────────────────────────────────────────────
@pytest.fixture
def cli(temp_db, monkeypatch):
    """Contexte d'exécution de la CLI + lecture de ce qu'elle a écrit.

    `db.init_engine` est neutralisé : la CLI rouvrirait sinon un moteur par appel, et les
    connexions laissées derrière feraient échouer le `DROP SCHEMA` de fin de test.
    """
    settings = Settings(
        _env_file=None,
        master_key=Fernet.generate_key().decode(),
        database_url=db.get_engine().url.render_as_string(hide_password=False),
    )
    monkeypatch.setattr("itsm_modern_ai.admin_setup.get_settings", lambda: settings)
    monkeypatch.setattr(db, "init_engine", lambda *a, **k: db.get_engine())
    box = FernetSecretsBox(master_key=settings.master_key)

    @contextmanager
    def _cfg() -> Iterator[RuntimeConfigService]:
        with Session(db.get_engine()) as s:
            yield RuntimeConfigService(s, box, settings)

    return _cfg


def test_cli_lit_stdin_et_ignore_la_variable_d_environnement(cli, monkeypatch):
    """RÉGRESSION : `_read_password` lisait ITSM_ADMIN_PASSWORD AVANT stdin.

    Dans un conteneur qui portait encore la variable, `--force` réinstallait donc
    silencieusement le MÊME mot de passe en affichant « ✓ enregistré » : mesuré, l'ancien
    mot de passe continuait d'authentifier. La saisie explicite prime désormais — et la
    variable n'est plus lue du tout.
    """
    monkeypatch.setenv("ITSM_ADMIN_PASSWORD", "mot-de-passe-de-lenv")
    monkeypatch.setattr("sys.stdin", io.StringIO("mot-de-passe-saisi\n"))
    assert main(["--email", EMAIL]) == 0

    with cli() as cfg:
        assert security.verify_login(cfg, EMAIL, "mot-de-passe-saisi") is True
        assert security.verify_login(cfg, EMAIL, "mot-de-passe-de-lenv") is False


def test_cli_refuse_de_creer_un_compte_sans_adresse(cli, monkeypatch, capsys):
    """Sans adresse, le compte serait créé mais AUCUNE connexion ne pourrait aboutir."""
    monkeypatch.setattr("sys.stdin", io.StringIO("mot-de-passe-saisi\n"))
    assert main([]) == 2
    assert "Adresse email requise" in capsys.readouterr().err
    with cli() as cfg:
        assert cfg.is_secret_set(HASH_KEY) is False


def test_cli_refuse_d_ecraser_sans_force(cli, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("premier-mot-de-passe\n"))
    assert main(["--email", EMAIL]) == 0
    monkeypatch.setattr("sys.stdin", io.StringIO("second-mot-de-passe\n"))
    assert main([]) == 2
    assert "--force" in capsys.readouterr().err
    with cli() as cfg:
        assert security.verify_login(cfg, EMAIL, "premier-mot-de-passe") is True


def test_cli_force_change_le_mot_de_passe_et_l_adresse(cli, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("premier-mot-de-passe\n"))
    assert main(["--email", EMAIL]) == 0
    monkeypatch.setattr("sys.stdin", io.StringIO("second-mot-de-passe\n"))
    assert main(["--force", "--email", "nouvelle@exemple.fr"]) == 0

    with cli() as cfg:
        assert cfg.admin_email() == "nouvelle@exemple.fr"
        assert security.verify_login(cfg, "nouvelle@exemple.fr", "second-mot-de-passe") is True
        assert security.verify_login(cfg, EMAIL, "premier-mot-de-passe") is False


def test_cli_email_only_change_l_adresse_sans_toucher_au_mot_de_passe(cli, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("premier-mot-de-passe\n"))
    assert main(["--email", EMAIL]) == 0
    with cli() as cfg:
        version_avant = cfg.session_version()

    assert main(["--email-only", "--email", "nouvelle@exemple.fr"]) == 0
    with cli() as cfg:
        assert cfg.admin_email() == "nouvelle@exemple.fr"
        assert security.verify_login(cfg, "nouvelle@exemple.fr", "premier-mot-de-passe") is True
        # Aucune rotation de secret → les sessions ouvertes survivent à un simple renommage.
        assert cfg.session_version() == version_avant


def test_cli_saisie_interactive_masquee_avec_confirmation(cli, monkeypatch):
    """Sans pipe, la CLI demande deux fois le mot de passe et refuse s'ils divergent."""
    saisies = iter(["premier-mot-de-passe", "faute-de-frappe"])
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("getpass.getpass", lambda _prompt: next(saisies))
    assert main(["--email", EMAIL]) == 2
    with cli() as cfg:
        assert cfg.is_secret_set(HASH_KEY) is False

    identiques = iter(["premier-mot-de-passe", "premier-mot-de-passe"])
    monkeypatch.setattr("getpass.getpass", lambda _prompt: next(identiques))
    assert main(["--email", EMAIL]) == 0
    with cli() as cfg:
        assert security.verify_login(cfg, EMAIL, "premier-mot-de-passe") is True


def test_cli_refuse_un_stdin_vide(cli, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert main(["--email", EMAIL]) == 2
    assert "Aucun mot de passe reçu" in capsys.readouterr().err


def test_cli_email_only_exige_une_adresse_valide(cli, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("premier-mot-de-passe\n"))
    assert main(["--email", EMAIL]) == 0
    assert main(["--email-only"]) == 2
    assert "--email-only exige --email" in capsys.readouterr().err
    assert main(["--email-only", "--email", "pas-une-adresse"]) == 2
    assert "Adresse email invalide" in capsys.readouterr().err
    with cli() as cfg:
        assert cfg.admin_email() == EMAIL  # inchangé


def test_cli_interrompue_ne_laisse_rien_derriere(cli, monkeypatch, capsys):
    def _interrompu() -> str:
        raise KeyboardInterrupt

    monkeypatch.setattr("itsm_modern_ai.admin_setup._read_password", _interrompu)
    assert main(["--email", EMAIL]) == 130
    assert "Annulé" in capsys.readouterr().err
    with cli() as cfg:
        assert cfg.is_secret_set(HASH_KEY) is False


def test_cli_email_only_refuse_sur_une_instance_vierge(cli, capsys):
    assert main(["--email-only", "--email", EMAIL]) == 2
    assert "Aucun compte administrateur" in capsys.readouterr().err


def test_cli_check_reflete_l_existence_du_compte(cli, monkeypatch, capsys):
    assert main(["--check"]) == 1
    assert "non configuré" in capsys.readouterr().out
    monkeypatch.setattr("sys.stdin", io.StringIO("premier-mot-de-passe\n"))
    assert main(["--email", EMAIL]) == 0
    assert main(["--check"]) == 0
