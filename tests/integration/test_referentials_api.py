"""Référentiels : sélection du périmètre via l'UI (FR-3/7/15/16) + métriques + SPA."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain.models import Referentials


def _settings(db_url, **kw) -> Settings:
    # admin sans mot de passe (test) — fail-closed désactivé, sauf surcharge explicite
    kw.setdefault("dev_open_admin", True)
    return Settings(
        _env_file=None,
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        **kw,
    )


@pytest.fixture
def client(db_url):
    with TestClient(create_app(_settings(db_url))) as c:
        yield c


def _seed_cache():
    """Alimente le cache comme le ferait un scan GLPI."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services import referentials

    with db.session_scope() as s:
        referentials.sync(
            s,
            Referentials(
                categories={1: "Compte", 2: "RH"},
                technicians={11: "Sylvain", 12: "Nadia"},
                groups={5: "Support N2"},
                entities={0: "Racine"},
            ),
        )


def test_discovery_lists_cached(client):
    _seed_cache()
    techs = client.get("/api/discovery/technician").json()
    assert {t["ext_id"] for t in techs} == {11, 12}
    assert all(t["eligible"] is False for t in techs)
    assert client.get("/api/discovery/unknown").status_code == 404


def test_set_and_read_execution_mode_per_entity(client):
    _seed_cache()
    # Entité sans mode → null par défaut (= défaut global).
    entities = client.get("/api/discovery/entity").json()
    assert entities[0]["mode"] is None
    # Régler full_auto sur l'entité racine.
    resp = client.put("/api/modes", json=[{"ext_id": 0, "mode": "full_auto"}])
    assert resp.status_code == 200
    assert next(e for e in resp.json() if e["ext_id"] == 0)["mode"] == "full_auto"
    # Un mode invalide est rejeté (validation Pydantic).
    assert client.put("/api/modes", json=[{"ext_id": 0, "mode": "bogus"}]).status_code == 422


def test_select_eligibility_and_scope_drives_effective_whitelist(client):
    _seed_cache()
    client.put("/api/technicians", json=[{"ext_id": 11, "eligible": True, "skills": "AD, sécurité"}])
    client.put("/api/groups", json=[{"ext_id": 5, "eligible": True, "skills": "Niveau 2"}])
    assert client.put("/api/scope", json={"category_ids": [1], "entity_ids": [0]}).json()["category_ids"] == [1]

    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services import referentials

    with db.session_scope() as s:
        eff = referentials.effective_referentials(s)
        assert eff.categories == {1: "Compte"}  # 2 non sélectionnée
        assert eff.technicians == {11: "Sylvain"}  # 12 non éligible
        assert eff.groups == {5: "Support N2"}
        assert "AD, sécurité" in referentials.routing_prose(s)


def test_sync_requires_glpi_configured(client):
    assert client.post("/api/glpi/sync").status_code == 409


def _brancher_scan(monkeypatch, refs: Referentials):
    """Branche un connecteur GLPI factice qui rapporte EXACTEMENT `refs`."""
    from itsm_modern_ai.api.routes import referentials as route

    class _Connector:
        async def get_referentials(self):
            return refs

    monkeypatch.setattr(route, "build_connector", lambda *a, **k: _Connector())


def _vieillir_le_cache(jours: int = 90):
    """Ramène TOUT le cache `jours` en arrière et rend l'horodatage posé."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update as sa_update

    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import ReferentialCache

    vieux = datetime.now(UTC) - timedelta(days=jours)
    with db.session_scope() as s:
        s.execute(sa_update(ReferentialCache).values(updated_at=vieux))
        s.commit()
    return vieux


def _horodatages(client, kind: str) -> dict[int, str]:
    """`{ext_id: updated_at}` tel que la console le lit."""
    return {r["ext_id"]: r["updated_at"] for r in client.get(f"/api/discovery/{kind}").json()}


def test_discovery_expose_la_fraicheur_du_cache(client, monkeypatch):
    """`updated_at` doit dater du DERNIER SCAN, pas de la création de la ligne.

    Sans cette distinction, un cache jamais rescanné depuis l'installation s'afficherait
    aussi frais qu'un cache scanné le matin même — et la console cesserait de pouvoir
    signaler qu'un technicien parti il y a trois mois est encore proposé au routage.
    Le test compare donc l'horodatage AVANT et APRÈS un scan : la seule non-nullité
    passerait à l'identique avec l'horodatage par défaut de la colonne.
    """
    from datetime import datetime

    _seed_cache()
    vieux = _vieillir_le_cache()  # les lignes existent, mais leur date est ancienne
    avant = _horodatages(client, "technician")
    assert all(datetime.fromisoformat(v) == vieux for v in avant.values())

    _brancher_scan(
        monkeypatch,
        Referentials(
            categories={1: "Compte", 2: "RH"},
            technicians={11: "Sylvain", 12: "Nadia"},
            groups={5: "Support N2"},
            entities={0: "Racine"},
        ),
    )
    assert client.post("/api/glpi/sync").json()["ok"] is True

    apres = _horodatages(client, "technician")
    assert all(
        datetime.fromisoformat(apres[e]) > datetime.fromisoformat(avant[e]) for e in avant
    ), "la console affiche la date de naissance des lignes, pas celle du dernier scan"


def test_un_scan_rafraichit_l_horodatage_meme_sans_changement(client, monkeypatch):
    """Un scan qui ne change RIEN doit quand même rajeunir le cache.

    C'est le cas courant : GLPI ne bouge pas d'une semaine sur l'autre. Si seul un vrai
    changement horodatait, la console crierait « référentiels anciens » sur des
    référentiels scannés le matin même.

    La prémisse est EXERCÉE, pas seulement énoncée : on vérifie qu'aucune donnée de la
    ligne ne bouge (même nom, même profil) et qu'une simple relecture ne rajeunit rien —
    sinon le test passerait par accident, la colonne n'ayant aucun `onupdate`.
    """
    from datetime import datetime

    _seed_cache()
    vieux = _vieillir_le_cache()
    noms_avant = {r["ext_id"]: r["name"] for r in client.get("/api/discovery/technician").json()}

    # Prémisse 1 : sans scan, rien ne bouge tout seul (pas d'`onupdate` sur la colonne).
    assert all(datetime.fromisoformat(v) == vieux for v in _horodatages(client, "technician").values())

    _brancher_scan(
        monkeypatch,
        Referentials(
            categories={1: "Compte", 2: "RH"},
            technicians={11: "Sylvain", 12: "Nadia"},  # contenu IDENTIQUE au scan précédent
            groups={5: "Support N2"},
            entities={0: "Racine"},
        ),
    )
    body = client.post("/api/glpi/sync").json()
    assert body["ok"] is True and body["counts"]["technician"] == 2

    apres = client.get("/api/discovery/technician").json()
    # Prémisse 2 : le scan n'a modifié AUCUNE donnée de la ligne.
    assert {r["ext_id"]: r["name"] for r in apres} == noms_avant
    assert all(datetime.fromisoformat(r["updated_at"]) > vieux for r in apres)


def test_un_objet_disparu_de_glpi_n_est_pas_rajeuni(client, monkeypatch):
    """Le défaut que l'horodatage existe pour rendre visible : le technicien PARTI.

    `sync` conserve délibérément les objets que GLPI ne renvoie plus. Les horodater
    quand même reviendrait à certifier « vu au dernier scan » un acteur que ce scan n'a
    justement pas vu — c'est-à-dire exactement le cas que la date est censée dénoncer.
    """
    from datetime import datetime

    _seed_cache()
    vieux = _vieillir_le_cache()

    _brancher_scan(
        monkeypatch,
        Referentials(
            categories={1: "Compte", 2: "RH"},
            technicians={11: "Sylvain"},  # 12 (Nadia) a quitté GLPI
            groups={5: "Support N2"},
            entities={0: "Racine"},
        ),
    )
    assert client.post("/api/glpi/sync").json()["ok"] is True

    stamps = _horodatages(client, "technician")
    assert datetime.fromisoformat(stamps[11]) > vieux, "le technicien vu au scan n'a pas ete horodate"
    assert datetime.fromisoformat(stamps[12]) == vieux, (
        "un technicien absent du scan a recu la date du scan qui ne l'a pas vu"
    )


def test_un_scan_sans_aucun_objet_sur_un_cache_peuple_est_une_anomalie(client, monkeypatch):
    """Compte technique déchu, mauvaise entité active, profil restreint : GLPI répond 200
    avec des listes VIDES. Annoncer « Référentiels synchronisés. » et rajeunir tout le
    cache donnerait un scan vert sur un périmètre que GLPI vient de désavouer.
    """
    from datetime import datetime

    _seed_cache()
    vieux = _vieillir_le_cache()

    _brancher_scan(monkeypatch, Referentials())  # GLPI ne rapporte plus rien
    body = client.post("/api/glpi/sync").json()

    assert body["ok"] is False, "un scan vide sur un cache peuplé a été annoncé comme un succès"
    assert "droits" in body["detail"].lower()
    # Le cache est conservé TEL QUEL : ni supprimé, ni rajeuni.
    assert all(datetime.fromisoformat(v) == vieux for v in _horodatages(client, "technician").values())
    assert len(client.get("/api/discovery/technician").json()) == 2


def test_un_scan_vide_sur_un_cache_vide_reste_un_succes(client, monkeypatch):
    """Instance neuve dont GLPI est réellement vide : pas de fausse alerte de droits.

    L'anomalie, c'est la DISPARITION de tout un périmètre déjà connu — pas l'absence
    d'objets sur une base qui n'en a jamais eu.
    """
    _brancher_scan(monkeypatch, Referentials())
    body = client.post("/api/glpi/sync").json()
    assert body["ok"] is True and body["counts"]["technician"] == 0


def test_metrics_endpoint(client):
    body = client.get("/api/metrics").json()
    assert body["total"] == 0 and body["cost_cap_eur_per_day"] == 5.0


def test_operational_metrics_unavailable_without_glpi(client):
    body = client.get("/api/operational-metrics").json()
    assert body["available"] is False and body["metrics"] is None


def test_root_reports_ui_not_built_when_no_dist(db_url, tmp_path):
    settings = _settings(db_url, frontend_dist=str(tmp_path / "nodist"))
    with TestClient(create_app(settings)) as c:
        r = c.get("/")
        assert r.status_code == 200 and r.json()["code"] == "ui_not_built"


def test_referentials_protected_when_auth_configured(db_url, creer_compte_admin):
    settings = _settings(db_url, dev_open_admin=False)
    with TestClient(create_app(settings)) as c:
        creer_compte_admin(c)  # compte créé à la première visite, puis déconnexion
        assert c.get("/api/discovery/technician").status_code == 401
        assert c.get("/api/metrics").status_code == 401


def test_entity_mode_change_is_audited(client):
    """Basculer une ENTITÉ en `full_auto` doit être imputable.

    C'est l'action d'administration la plus lourde du produit : elle autorise l'IA à
    muter des Tickets GLPI et à répondre PUBLIQUEMENT aux demandeurs. Le mode par entité
    vit dans `referential_cache`, donc hors du traçage automatique de
    `RuntimeConfigService.set` — sans l'audit explicite de la route, seul le défaut
    GLOBAL était imputable et cette bascule ne laissait aucune trace.
    """
    from sqlmodel import select

    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import AuditLog, ReferentialCache

    with db.session_scope() as session:
        session.add(ReferentialCache(kind="entity", ext_id=77, name="Siège", selected=True))
        session.commit()

    assert client.put(
        "/api/modes", json=[{"ext_id": 77, "mode": "full_auto", "auto_min_confidence": 0.95}]
    ).status_code == 200

    with db.session_scope() as session:
        lignes = [a for a in session.exec(select(AuditLog)).all() if a.action == "entity_mode"]
    assert len(lignes) == 1, "la bascule d'une entité en full_auto n'a pas été auditée"
    assert lignes[0].key == "entity:77"
    assert "full_auto" in lignes[0].new_value
    assert "défaut global" in lignes[0].old_value


def test_unchanged_entity_modes_do_not_flood_the_audit_log(client):
    """Réécrire la liste sans rien changer ne doit pas produire d'entrée.

    L'UI renvoie TOUTES les entités à chaque enregistrement : sans ce filtrage, une
    simple visite de l'écran noierait le journal d'imputabilité sous du bruit.
    """
    from sqlmodel import select

    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import AuditLog, ReferentialCache

    with db.session_scope() as session:
        session.add(ReferentialCache(kind="entity", ext_id=88, name="Agence", selected=True))
        session.commit()

    corps = [{"ext_id": 88, "mode": "semi_auto", "auto_min_confidence": None}]
    client.put("/api/modes", json=corps)      # 1er appel : changement réel
    client.put("/api/modes", json=corps)      # 2e appel : strictement identique

    with db.session_scope() as session:
        lignes = [a for a in session.exec(select(AuditLog)).all() if a.key == "entity:88"]
    assert len(lignes) == 1, "une réécriture sans changement a produit une entrée d'audit"


def test_catalogue_de_competences_est_expose(client):
    """La console doit lire le catalogue depuis l'API, jamais le dupliquer.

    Une liste divergente ferait cocher des clés que le moteur ignorerait en silence.
    """
    r = client.get("/api/skills")
    assert r.status_code == 200
    cat = r.json()
    assert len(cat) == 14
    cles = {d["key"] for d in cat}
    assert {"workstation", "network", "accounts", "erp_finance"} <= cles
    assert all(d["label_fr"] and d["label_en"] and d["hint_fr"] for d in cat)


def test_competences_cochees_decrivent_le_technicien_sans_prose(client):
    """LE cas du jour 1 : cocher suffit à rendre un technicien exploitable par le LLM.

    Sans cases ni prose, `routing_prose` n'incluait aucune description et le modèle
    routait sur un patronyme — d'où des rejets `low_confidence`.
    """
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import ReferentialCache
    from itsm_modern_ai.services import referentials

    with db.session_scope() as s:
        s.add(ReferentialCache(kind="technician", ext_id=42, name="Alice"))
        s.commit()

    assert client.put(
        "/api/technicians",
        json=[{"ext_id": 42, "eligible": True, "skills": "", "skill_tags": ["workstation", "printing"]}],
    ).status_code == 200

    with db.session_scope() as s:
        prose = referentials.routing_prose(s)
    assert "Alice" in prose
    assert "Poste de travail" in prose and "Impression" in prose
    # Le `hint` accompagne le libellé : c'est lui qui rend deux domaines discriminables.
    assert "imprimantes" in prose


def test_prose_libre_passe_apres_le_socle_coche(client):
    """La nuance rédigée doit primer sur le domaine générique — donc être lue en dernier."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import ReferentialCache
    from itsm_modern_ai.services import referentials

    with db.session_scope() as s:
        s.add(ReferentialCache(kind="technician", ext_id=43, name="Bob"))
        s.commit()
    client.put(
        "/api/technicians",
        json=[{"ext_id": 43, "eligible": True, "skills": "Ne gère pas les Mac.",
               "skill_tags": ["workstation"]}],
    )
    with db.session_scope() as s:
        prose = referentials.routing_prose(s)
    assert prose.index("Domaines :") < prose.index("Ne gère pas les Mac.")


def test_client_sans_skill_tags_ne_efface_pas_la_selection(client):
    """Un client plus ancien qui ignore le champ ne doit pas effacer les cases cochées."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import ReferentialCache

    with db.session_scope() as s:
        s.add(ReferentialCache(kind="technician", ext_id=44, name="Carl"))
        s.commit()
    client.put("/api/technicians", json=[{"ext_id": 44, "eligible": True, "skills": "", "skill_tags": ["security"]}])
    client.put("/api/technicians", json=[{"ext_id": 44, "eligible": True, "skills": "note"}])  # sans le champ

    r = [x for x in client.get("/api/discovery/technician").json() if x["ext_id"] == 44][0]
    assert r["skill_tags"] == ["security"], "une sélection a été effacée par un client qui l'ignorait"


def test_cles_inconnues_sont_ignorees_sans_bloquer(client):
    """Perdre une case est préférable à empêcher un admin d'enregistrer son périmètre."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import ReferentialCache

    with db.session_scope() as s:
        s.add(ReferentialCache(kind="technician", ext_id=45, name="Dana"))
        s.commit()
    assert client.put(
        "/api/technicians",
        json=[{"ext_id": 45, "eligible": True, "skills": "", "skill_tags": ["network", "n_existe_pas"]}],
    ).status_code == 200
    r = [x for x in client.get("/api/discovery/technician").json() if x["ext_id"] == 45][0]
    assert r["skill_tags"] == ["network"]


# ── Carte de couverture des domaines (0.9.50) ────────────────────────────────────────


def test_couverture_compte_separement_techniciens_et_groupes(client):
    """Un groupe absorbe une absence, un technicien seul non : les compteurs restent
    distincts. Les fusionner effacerait la nuance qui rend l'alerte actionnable."""
    _seed_cache()
    client.put(
        "/api/technicians",
        json=[{"ext_id": 11, "eligible": True, "skills": "", "skill_tags": ["network", "printing"]}],
    )
    client.put(
        "/api/groups",
        json=[{"ext_id": 5, "eligible": True, "skills": "", "skill_tags": ["network"]}],
    )

    couverture = {d["key"]: d for d in client.get("/api/skills/coverage").json()}
    assert len(couverture) == 14  # le catalogue ENTIER, y compris les domaines à zéro
    assert (couverture["network"]["technicians"], couverture["network"]["groups"]) == (1, 1)
    assert (couverture["printing"]["technicians"], couverture["printing"]["groups"]) == (1, 0)
    # Domaine que personne ne couvre : « à trier » garanti dès qu'un ticket en relève.
    assert (couverture["security"]["technicians"], couverture["security"]["groups"]) == (0, 0)


def test_couverture_ignore_les_acteurs_non_eligibles(client):
    """Cocher des domaines sur quelqu'un de NON éligible ne couvre rien : le moteur ne
    route jamais vers lui. Le compter donnerait une carte rassurante et fausse."""
    _seed_cache()
    client.put(
        "/api/technicians",
        json=[{"ext_id": 12, "eligible": False, "skills": "", "skill_tags": ["telephony"]}],
    )
    couverture = {d["key"]: d for d in client.get("/api/skills/coverage").json()}
    assert couverture["telephony"]["technicians"] == 0


def test_couverture_ne_nomme_aucun_acteur(client):
    """Anti-mouchard (FR-18/21) : une carte de la CONFIGURATION, pas une mesure des
    personnes. Aucun nom, aucun identifiant d'acteur ne doit sortir par cet endpoint."""
    _seed_cache()
    client.put(
        "/api/technicians",
        json=[{"ext_id": 11, "eligible": True, "skills": "", "skill_tags": ["network"]}],
    )
    brut = client.get("/api/skills/coverage").text
    assert "Sylvain" not in brut and "ext_id" not in brut
    assert set(client.get("/api/skills/coverage").json()[0]) == {
        "key", "label_fr", "label_en", "technicians", "groups",
    }


# ── Cible de repli par entité (0.9.52) ───────────────────────────────────────────────


def test_repli_hors_perimetre_est_refuse_a_l_enregistrement(client):
    """Accepter silencieusement produirait une configuration INOPÉRANTE : le moteur
    revalide la cible à l'écriture et n'assignerait rien, sans que l'admin sache pourquoi."""
    _seed_cache()
    r = client.put(
        "/api/modes",
        json=[{"ext_id": 0, "mode": "full_auto", "fallback_group_id": 5}],  # groupe non éligible
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "fallback_not_eligible"
    # Rien n'a été enregistré : l'entité garde son état antérieur.
    entite = [e for e in client.get("/api/discovery/entity").json() if e["ext_id"] == 0][0]
    assert entite["fallback_group_id"] is None


def test_repli_accepte_une_fois_la_cible_eligible(client):
    _seed_cache()
    client.put("/api/groups", json=[{"ext_id": 5, "eligible": True, "skills": ""}])
    assert client.put(
        "/api/modes", json=[{"ext_id": 0, "mode": "full_auto", "fallback_group_id": 5}]
    ).status_code == 200

    entite = [e for e in client.get("/api/discovery/entity").json() if e["ext_id"] == 0][0]
    assert entite["fallback_group_id"] == 5 and entite["fallback_technician_id"] is None


def test_changement_de_cible_de_repli_est_audite(client):
    """Autoriser le moteur à assigner un acteur sur un Ticket refusé est une décision de
    gouvernance : elle doit être imputable au même titre que le mode."""
    _seed_cache()
    client.put("/api/groups", json=[{"ext_id": 5, "eligible": True, "skills": ""}])
    client.put("/api/modes", json=[{"ext_id": 0, "mode": "full_auto", "fallback_group_id": 5}])

    from sqlmodel import select

    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import AuditLog

    with db.session_scope() as session:
        lignes = [a for a in session.exec(select(AuditLog)).all() if a.action == "entity_mode"]
    assert len(lignes) == 1
    assert "repli groupe #5" in lignes[0].new_value
    assert "repli" not in lignes[0].old_value  # aucun repli configuré auparavant
