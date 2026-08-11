"""Secrets chiffrés (FR-25) + service de config runtime (secrets via API, pas .env)."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet

from itsm_modern_ai.adapters.secrets import encrypted as encrypted_module
from itsm_modern_ai.adapters.secrets.encrypted import (
    ALLOW_NEW_KEY_ENV,
    FernetSecretsBox,
    MasterKeyGuardError,
    MasterKeyLostError,
    MasterKeyUndeterminedError,
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
#
# Ces tests interrogent la VRAIE base : depuis le passage à PostgreSQL exclusif,
# `has_encrypted_secrets()` n'a plus de repli « fichier voisin » — la seule source de
# vérité est le moteur ouvert. Un secret posé par `RuntimeConfigService` est donc la seule
# façon honnête de mettre le garde-fou en situation.


def _pose_un_secret(session, cle: str = "llm_api_key", valeur: str = "sk-abc") -> None:
    """Chiffre un secret dans la base du test, avec une clé maître dont on se moque ensuite.

    C'est exactement l'état d'un exploitant en production : des secrets illisibles sans le
    fichier `master.key` qui vient de disparaître.
    """
    box = FernetSecretsBox(master_key=Fernet.generate_key().decode())
    RuntimeConfigService(session, box, Settings(_env_file=None)).set_secret(cle, valeur)
    session.commit()


def test_master_key_lost_with_existing_secrets_refuses_to_start(session, tmp_path):
    """Base avec secrets + master.key disparue → refus explicite, AUCUNE clé générée."""
    _pose_un_secret(session)

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


def test_une_base_sans_secret_chiffre_ne_bloque_pas(session, tmp_path):
    """Le garde-fou distingue « il y a des lignes » de « il y a des SECRETS ».

    Deux pièges couverts par `_HAS_SECRETS_SQL` et par rien d'autre : une ligne de config
    EN CLAIR (`is_secret` faux) et un secret VIDÉ (`is_secret` vrai mais `value = ''`,
    ce qu'écrit `set_secret(key, "")` quand l'admin efface une clé LLM). Ni l'une ni
    l'autre n'a quoi que ce soit à perdre : bloquer dessus interdirait un premier
    démarrage parfaitement légitime.
    """
    box = FernetSecretsBox(master_key=Fernet.generate_key().decode())
    cfg = RuntimeConfigService(session, box, Settings(_env_file=None))
    cfg.set("llm_model", "mistral-small-latest")
    cfg.set_secret("glpi_user_token", "")
    session.commit()
    assert db.has_encrypted_secrets() is False

    key_file = tmp_path / "master.key"
    FernetSecretsBox(key_file=key_file)
    assert key_file.exists()


def test_explicit_escape_hatch_allows_a_new_key(session, tmp_path, monkeypatch):
    """« Je repars de zéro en connaissance de cause » reste possible, mais EXPLICITE.

    Le test vaut par ses DEUX moitiés : sans la variable, la même base refuse de démarrer ;
    avec elle, la clé est générée — et l'ancien secret devient bien illisible, ce que
    l'échappatoire promet noir sur blanc. Sans cette dernière assertion, on ne vérifierait
    que l'absence d'exception.
    """
    _pose_un_secret(session)
    key_file = tmp_path / "master.key"
    with pytest.raises(MasterKeyLostError):
        FernetSecretsBox(key_file=key_file)  # sans échappatoire : refus

    monkeypatch.setenv(ALLOW_NEW_KEY_ENV, "true")
    nouvelle = FernetSecretsBox(key_file=key_file)
    assert key_file.exists()
    cfg = RuntimeConfigService(session, nouvelle, Settings(_env_file=None))
    with pytest.raises(SecretDecryptError):
        cfg.get_secret("llm_api_key")


def test_master_key_from_env_bypasses_the_guard(session, tmp_path):
    """MASTER_KEY fournie : aucune génération, donc rien à écraser — pas de blocage.

    Et rien ne doit être écrit sur disque au passage : c'est le mode « secret monté »,
    où `data/master.key` n'existe pas et ne doit pas apparaître.
    """
    _pose_un_secret(session)
    key_file = tmp_path / "master.key"
    box = FernetSecretsBox(master_key=Fernet.generate_key().decode(), key_file=key_file)
    assert box.decrypt(box.encrypt("x")) == "x"
    assert not key_file.exists()


def test_base_injoignable_refuse_de_demarrer_sans_ecrire_de_cle(tmp_path, monkeypatch):
    """Serveur muet : on ne sait pas s'il y a des secrets → on REFUSE, et on n'écrit rien.

    Le cas mesuré comme le plus grave, parce qu'il se maquillait en succès : « base
    injoignable → démarrage OK, clé écrite : OUI ». La clé neuve rendait ensuite
    `key_file.exists()` vrai, donc le garde-fou n'était plus jamais consulté — l'instance
    tournait « au vert » avec un login refusé et des tokens illisibles, diagnostic perdu.
    On vérifie les DEUX moitiés : le refus, et surtout l'absence de fichier écrit.
    """
    monkeypatch.setattr(encrypted_module, "ESSAIS_BASE", 3)
    monkeypatch.setattr(encrypted_module, "DELAI_BASE_S", 0)
    essais = []

    def _injoignable():
        essais.append(1)
        raise db.BaseInjoignableError("connection refused")

    monkeypatch.setattr(db, "has_encrypted_secrets", _injoignable)

    key_file = tmp_path / "master.key"
    with pytest.raises(MasterKeyUndeterminedError) as exc:
        FernetSecretsBox(key_file=key_file)

    assert not key_file.exists(), "une clé écrite désarmerait le garde-fou pour toujours"
    assert len(essais) == 3, "la base et le moteur démarrent ensemble : il faut réessayer"
    assert ALLOW_NEW_KEY_ENV in str(exc.value)  # message actionnable
    # Fail-fast à l'échelle de l'application : le refus ne doit pas être avalé au profit
    # d'un secret de session éphémère (c'est ce que fait le `except Exception` de create_app).
    assert isinstance(exc.value, MasterKeyGuardError)


def test_le_refus_survit_au_redemarrage_suivant(session, tmp_path, monkeypatch):
    """Un boot refusé ne doit rien laisser derrière lui qui neutralise le suivant.

    Enchaînement réel : la base tombe (refus), puis elle revient avec ses secrets. Le
    second démarrage doit reposer la question et rendre le VRAI diagnostic — pas démarrer
    parce qu'un premier échec aurait déposé une clé.
    """
    monkeypatch.setattr(encrypted_module, "ESSAIS_BASE", 1)
    monkeypatch.setattr(encrypted_module, "DELAI_BASE_S", 0)
    key_file = tmp_path / "master.key"

    def _injoignable():
        raise db.BaseInjoignableError("connection refused")

    monkeypatch.setattr(db, "has_encrypted_secrets", _injoignable)
    with pytest.raises(MasterKeyUndeterminedError):
        FernetSecretsBox(key_file=key_file)

    monkeypatch.undo()  # la base revient… avec ses secrets
    _pose_un_secret(session)
    with pytest.raises(MasterKeyLostError):
        FernetSecretsBox(key_file=key_file)
    assert not key_file.exists()


def test_l_application_refuse_de_demarrer_sur_une_base_injoignable(tmp_path, monkeypatch):
    """Bout en bout : `create_app` ne démarre pas « au vert » quand la question est sans réponse."""
    from itsm_modern_ai.api.app import create_app

    monkeypatch.setattr(encrypted_module, "ESSAIS_BASE", 2)
    monkeypatch.setattr(encrypted_module, "DELAI_BASE_S", 0)
    monkeypatch.chdir(tmp_path)  # `data/master.key` est relatif : on l'isole ici

    with pytest.raises(MasterKeyGuardError):
        create_app(_settings_app("postgresql+psycopg://itsm:itsm@127.0.0.1:1/itsm"))
    assert not (tmp_path / "data" / "master.key").exists()


def test_has_encrypted_secrets_distingue_base_vide_et_serveur_injoignable(db_url, monkeypatch):
    """« La base est vide » et « je n'ai pas pu poser la question » ne sont PAS la même chose.

    C'était le trou : tout échec rendait `None`, donc un serveur injoignable était traité
    comme un premier démarrage — on générait une clé neuve, on l'écrivait, et le garde-fou
    ne se réarmait plus jamais (`key_file.exists()` renvoie avant lui). Un serveur muet lève
    désormais `BaseInjoignableError` ; une table absente reste une réponse TRANCHÉE (la base
    répond, elle n'est simplement pas encore migrée : il n'y a rien à perdre).
    """
    monkeypatch.setattr(db, "_engine", None)
    assert db.has_encrypted_secrets() is None  # moteur pas encore ouvert : indéterminé

    # Serveur injoignable (port fermé) : le moteur existe, la connexion échoue.
    db.init_engine("postgresql+psycopg://itsm:itsm@127.0.0.1:1/itsm", pool_pre_ping=False)
    with pytest.raises(db.BaseInjoignableError):
        db.has_encrypted_secrets()

    # Base joignable mais pas encore migrée : la table `runtime_config` n'existe pas.
    db.init_engine(db_url)
    assert db.has_encrypted_secrets() is False
    db.create_all()
    assert db.has_encrypted_secrets() is False  # base lisible et vide : réponse tranchée


def test_has_encrypted_secrets_uses_the_open_engine(session):
    """Moteur ouvert (cas nominal du boot) : la réponse vient de la base réelle."""
    assert db.has_encrypted_secrets() is False
    _pose_un_secret(session, "glpi_user_token", "t")
    assert db.has_encrypted_secrets() is True


# ── Ordre d'amorçage de l'application : moteur AVANT boîte à secrets ──────────
# Régression vécue : `create_app` construisait la boîte à secrets (dérivation du secret de
# session) avant `db.init_engine`. Le garde-fou ci-dessus était alors intégralement
# contourné — `has_encrypted_secrets()` répondait `None` faute de moteur, une clé neuve
# était générée, et l'exploitant démarrait « au vert » avec des secrets définitivement
# illisibles. Les deux tests suivants verrouillent cet ordre par ses CONSÉQUENCES.


def test_l_amorcage_ouvre_le_moteur_avant_de_construire_la_boite_a_secrets(db_url, monkeypatch):
    """Au moment où `create_app` fabrique sa première boîte, la base doit être interrogeable.

    On n'observe pas l'ordre des appels (un tel test ne ferait que recopier
    l'implémentation) mais son seul effet qui compte : la boîte doit VOIR les secrets déjà
    chiffrés. Moteur ouvert après, la réponse serait `None` et le garde-fou muet.

    Le scénario est celui d'une instance déjà exploitée qui redémarre — le seul où il y a
    quelque chose à perdre : tables migrées, secrets en base.
    """
    from itsm_modern_ai.api import app as app_module

    db.init_engine(db_url)
    db.create_all()
    with db.session_scope() as s:
        _pose_un_secret(s)

    reponses: list[bool | None] = []
    vraie_fabrique = app_module.make_secrets_box

    def _espion(settings):
        reponses.append(db.has_encrypted_secrets())
        return vraie_fabrique(settings)

    monkeypatch.setattr(app_module, "make_secrets_box", _espion)
    # `master_key` fournie : la boîte n'a rien à générer, donc rien à refuser — on isole
    # la question de l'ORDRE de celle du refus (couvert par le test suivant).
    app_module.create_app(_settings_app(db_url, master_key=Fernet.generate_key().decode()))
    assert reponses == [True], "moteur non ouvert : le garde-fou master.key est muet"


def test_perte_de_master_key_bloque_le_demarrage_de_l_application(db_url, tmp_path, monkeypatch):
    """Bout en bout : l'app refuse de démarrer si la clé a disparu du volume.

    Remplace l'ancien test « base fichier voisine de la clé » : ce repli de lecture
    n'existe plus, mais le scénario d'exploitation qu'il gardait — volume `./data` amputé
    de sa `master.key` — est exactement celui-ci, désormais joué sur la vraie base.
    """
    from fastapi.testclient import TestClient

    from itsm_modern_ai.api.app import create_app

    monkeypatch.chdir(tmp_path)  # `data/master.key` est un chemin RELATIF : on l'isole ici
    key_file = tmp_path / "data" / "master.key"
    settings = _settings_app(db_url)

    with TestClient(create_app(settings)) as client:  # 1er démarrage légitime
        assert key_file.exists()
        assert client.post("/api/config", json={"llm_api_key": "sk-abc"}).status_code == 200

    key_file.unlink()  # sinistre : le volume a perdu sa clé, la base est intacte
    with pytest.raises(MasterKeyLostError):
        create_app(settings)
    assert not key_file.exists()  # aucune clé neuve : la restauration reste possible


def _settings_app(db_url, **kw) -> Settings:
    """Réglages d'une app de test. `master_key` vide par défaut : c'est `data/master.key`
    qui décide — sinon la boîte n'a rien à générer et le garde-fou ne joue pas."""
    kw.setdefault("master_key", "")
    return Settings(
        _env_file=None,
        database_url=db_url,
        polling_enabled=False,
        dev_open_admin=True,
        session_https_only=False,
        frontend_dist="nodist",
        **kw,
    )
