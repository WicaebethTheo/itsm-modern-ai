"""`POST /api/polling/run` — un cycle de polling déclenché à la main.

Le moteur poll à intervalle fixe ; entre deux battements, un exploitant qui vient de
brancher GLPI n'a aucun moyen de savoir si ça marche. Ce qui est vérifié ici : le cycle
lancé est CELUI du scheduler (il persiste les mêmes compteurs), et les trois refus sont
rendus explicitement au lieu d'un silence indiscernable d'un cycle vide.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain.models import Referentials, Ticket
from itsm_modern_ai.persistence import db
from itsm_modern_ai.services import referentials

REFS = Referentials(categories={1: "Compte"}, technicians={11: "Syl"})


class FakeGlpi:
    """Connecteur GLPI minimal — le cycle doit pouvoir tourner sans GLPI réel."""

    def __init__(self, tickets: list[Ticket]) -> None:
        self._tickets = tickets

    async def get_referentials(self) -> Referentials:
        return REFS

    async def get_new_tickets(self) -> list[Ticket]:
        return self._tickets

    async def write_followup(self, ticket_id, content, *, private=True) -> int:
        return 1

    async def healthcheck(self) -> bool:
        return True


def _settings(db_url, **kw) -> Settings:
    kw.setdefault("polling_enabled", False)
    kw.setdefault("dev_open_admin", True)  # admin sans mot de passe (test)
    return Settings(
        _env_file=None,  # isole du .env ambiant
        database_url=db_url,
        master_key=Fernet.generate_key().decode(),
        session_https_only=False,
        **kw,
    )


@pytest.fixture
def client(db_url):
    with TestClient(create_app(_settings(db_url))) as c:
        yield c


def test_le_declenchement_manuel_exige_une_session(db_url, creer_compte_admin):
    """Un cycle coûte des appels LLM et peut écrire dans GLPI : jamais sans session."""
    settings = _settings(db_url, dev_open_admin=False)
    with TestClient(create_app(settings)) as c:
        creer_compte_admin(c)
        assert c.post("/api/polling/run").status_code == 401


def test_la_pause_du_polling_n_est_PAS_contournee(client):
    """La pause est l'arrêt d'urgence du produit — un bouton ne doit pas passer outre.

    Elle est le geste recommandé quand le masquage avancé retombe (licence expirée) ou
    qu'un fournisseur déraille : un déclenchement manuel qui l'ignorerait renverrait des
    données au LLM que l'exploitant venait précisément d'arrêter d'envoyer.
    """
    r = client.post("/api/polling/run")
    assert r.status_code == 200
    body = r.json()
    assert body["outcome"] == "polling_disabled"
    assert body["ran"] is False
    # Aucun cycle n'a tourné : le bloc reste sur « jamais exécuté ».
    assert body["cycle"]["has_run"] is False


def test_sans_connexion_glpi_la_cause_est_nommee(client):
    client.post("/api/config", json={"polling_enabled": True})
    body = client.post("/api/polling/run").json()
    assert body["outcome"] == "glpi_not_configured"
    assert body["ran"] is False


def test_un_cycle_reel_tourne_et_rend_ses_compteurs(client, monkeypatch):
    """Le cycle manuel est le cycle du scheduler : mêmes compteurs, même persistance."""
    monkeypatch.setattr(
        "itsm_modern_ai.api.app.build_connector",
        lambda settings, secrets: FakeGlpi([Ticket(id=1, content="x"), Ticket(id=2, content="y")]),
    )
    client.post("/api/config", json={"polling_enabled": True})
    # Périmètre EFFECTIF non vide, sinon le poller saute le cycle sans consommer de ticket.
    with db.session_scope() as s:
        referentials.sync(s, REFS)
        referentials.set_scope(s, category_ids=[1], entity_ids=[])

    body = client.post("/api/polling/run").json()
    assert body["outcome"] == "ran"
    assert body["ran"] is True
    assert body["cycle"]["has_run"] is True
    assert body["cycle"]["fetched"] == 2
    assert body["cycle"]["processed"] == 2
    assert body["duration_ms"] >= 0

    # Les compteurs rendus sont bien ceux PERSISTÉS : `GET /api/status` dit la même chose.
    status = client.get("/api/status").json()
    assert status["last_poll"]["fetched"] == 2
    assert status["last_poll"]["processed"] == 2


def test_un_cycle_deja_en_cours_n_en_declenche_pas_un_second(client):
    """Deux pollers sur la même file paieraient chacun leurs appels LLM.

    L'idempotence les protégerait des doublons d'écriture GLPI, pas de la double facture.
    On injecte un verrou déjà pris (`api/app.poll_lock` le prend tel quel) : le second
    déclenchement doit renoncer, pas attendre.
    """

    class VerrouOccupe:
        def locked(self) -> bool:
            return True

    client.app.state.poll_lock = VerrouOccupe()
    client.post("/api/config", json={"polling_enabled": True})
    body = client.post("/api/polling/run").json()
    assert body["outcome"] == "already_running"
    assert body["ran"] is False
