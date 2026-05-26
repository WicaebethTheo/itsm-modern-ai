"""Tests de la mécanique du spike + intégrité des fixtures (Story 1.1/1.3)."""

from __future__ import annotations

import json
from pathlib import Path

from itsm_modern_ai.spike_tech_profiles import load_tech_profiles

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "fixtures" / "tickets_fr.json"
PROFILES = REPO / "tests" / "fixtures" / "tech_profiles_fr.yaml"


def test_fixtures_are_coherent_with_referentials():
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    cats = {int(k) for k in data["referentials"]["categories"]}
    techs = {int(k) for k in data["referentials"]["technicians"]}
    prios = {int(k) for k in data["referentials"]["priorities"]}
    assert data["tickets"], "le jeu de tickets ne doit pas être vide"

    has_decided = has_a_trier = has_signal = False
    for t in data["tickets"]:
        if t["expected_outcome"] == "decided":
            has_decided = True
            assert t["expected_category"] in cats, t["id"]
            assert t["expected_technician_id"] in techs, t["id"]
            assert t["expected_priority"] in prios, t["id"]
        else:
            assert t["expected_outcome"] == "a_trier"
            has_a_trier = True
        if "signal_faible" in t.get("tags", []):
            has_signal = True
    # Le jeu doit couvrir cas décidables, cas « à trier » et signaux faibles (Story 1.1).
    assert has_decided and has_a_trier and has_signal


def test_tech_profiles_load_as_prose():
    profiles = load_tech_profiles(PROFILES)
    prose = profiles.as_prose()
    assert "Sylvain" in prose
    assert len(profiles.profiles) >= 3


def test_threshold_sweep_and_suggestion_run():
    # Import paresseux du script de spike (hors package).
    import importlib.util
    import sys

    spec = importlib.util.spec_from_file_location(
        "spike_routing", REPO / "scripts" / "spike_routing.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # requis pour résoudre les annotations des dataclass
    spec.loader.exec_module(mod)

    ev_good = mod.TicketEval(
        id=1, tags=[], expected_outcome="decided", expected_category=1,
        expected_technician_id=11, expected_priority=3, masked_content="x",
        masking_counts={}, secret_flag=False,
    )
    ev_good.category, ev_good.technician_id, ev_good.confidence = 1, 11, 0.9
    ev_good.whitelist_ok = True

    ev_oos = mod.TicketEval(
        id=2, tags=["hors_perimetre"], expected_outcome="a_trier",
        expected_category=None, expected_technician_id=None, expected_priority=None,
        masked_content="y", masking_counts={}, secret_flag=False,
    )
    ev_oos.category, ev_oos.technician_id, ev_oos.confidence = 1, 11, 0.3
    ev_oos.whitelist_ok = True

    rows = mod._sweep_thresholds([ev_good, ev_oos])
    assert len(rows) == 20
    suggested = mod._suggest_threshold(rows)
    # Un seuil entre 0.3 et 0.9 évite le faux-accepté hors-périmètre (conf 0.3)
    # tout en gardant le bon (conf 0.9).
    assert 0.3 < suggested <= 0.9
