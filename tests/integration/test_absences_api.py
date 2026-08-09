"""API des absences : les trois pièges refusés À LA SAISIE, pas découverts en production."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from itsm_modern_ai.api.app import create_app
from itsm_modern_ai.config.settings import Settings


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'abs.db'}",
        master_key=Fernet.generate_key().decode(),
        polling_enabled=False,
        dev_open_admin=True,
    )
    with TestClient(create_app(settings)) as c:
        yield c


def _seed(client, *, eligibles=(11, 12), non_eligibles=(13,)):
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.persistence.tables import ReferentialCache

    with db.session_scope() as s:
        for ext_id in eligibles:
            s.add(ReferentialCache(kind="technician", ext_id=ext_id, name=f"T{ext_id}", eligible=True))
        for ext_id in non_eligibles:
            s.add(ReferentialCache(kind="technician", ext_id=ext_id, name=f"T{ext_id}", eligible=False))
        s.commit()


def _jour(delta: int) -> str:
    return (date.today() + timedelta(days=delta)).isoformat()


def test_absence_simple_est_enregistree_et_marquee_active(client):
    _seed(client)
    r = client.put(
        "/api/absences",
        json=[{"technician_ext_id": 11, "start_date": _jour(-1), "end_date": _jour(1),
               "replacement_ext_id": 12, "note": "congés"}],
    )
    assert r.status_code == 200
    a = r.json()[0]
    assert a["technician_name"] == "T11" and a["replacement_name"] == "T12"
    assert a["active"] is True  # couvre la journée en cours


def test_remplacant_non_eligible_refuse(client):
    """Piège 1 : le moteur ne route jamais vers lui — l'intérim serait sans effet, et
    l'admin croirait avoir posé un filet qui n'a jamais existé."""
    _seed(client)
    r = client.put(
        "/api/absences",
        json=[{"technician_ext_id": 11, "start_date": _jour(0), "end_date": _jour(2),
               "replacement_ext_id": 13}],
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "replacement_not_eligible"
    assert client.get("/api/absences").json() == []  # rien n'a été enregistré


def test_remplacant_lui_meme_absent_refuse(client):
    """Piège 2 : on ne construit PAS de résolveur de graphe — un seul saut, et le cas qui
    le casserait est refusé à la saisie."""
    _seed(client)
    r = client.put(
        "/api/absences",
        json=[
            {"technician_ext_id": 11, "start_date": _jour(0), "end_date": _jour(5),
             "replacement_ext_id": 12},
            {"technician_ext_id": 12, "start_date": _jour(3), "end_date": _jour(8)},
        ],
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "replacement_also_absent"


def test_remplacant_absent_sur_une_autre_periode_est_accepte(client):
    """Le refus doit porter sur un CHEVAUCHEMENT, pas sur « B a des congés un jour »."""
    _seed(client)
    r = client.put(
        "/api/absences",
        json=[
            {"technician_ext_id": 11, "start_date": _jour(0), "end_date": _jour(2),
             "replacement_ext_id": 12},
            {"technician_ext_id": 12, "start_date": _jour(20), "end_date": _jour(25)},
        ],
    )
    assert r.status_code == 200


def test_periode_incoherente_refusee(client):
    _seed(client)
    r = client.put(
        "/api/absences",
        json=[{"technician_ext_id": 11, "start_date": _jour(5), "end_date": _jour(1)}],
    )
    assert r.status_code == 400 and r.json()["detail"]["code"] == "invalid_period"


def test_absent_disparait_du_perimetre_effectif(client):
    """Le filtre compose avec tout l'aval : jamais proposé au LLM, donc jamais assigné."""
    from itsm_modern_ai.persistence import db
    from itsm_modern_ai.services import referentials

    _seed(client)
    client.put(
        "/api/absences",
        json=[{"technician_ext_id": 11, "start_date": _jour(-1), "end_date": _jour(1)}],
    )
    with db.session_scope() as s:
        refs = referentials.effective_referentials(s)
    assert 11 not in refs.technicians and 12 in refs.technicians


def test_technicien_ne_peut_pas_se_remplacer_lui_meme(client):
    _seed(client)
    r = client.put(
        "/api/absences",
        json=[{"technician_ext_id": 11, "start_date": _jour(0), "end_date": _jour(1),
               "replacement_ext_id": 11}],
    )
    assert r.status_code == 400 and r.json()["detail"]["code"] == "replacement_is_absent_actor"
