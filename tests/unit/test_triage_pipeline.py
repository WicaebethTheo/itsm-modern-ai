"""Pipeline de triage (FR-5→10, 14, 17, 18) — cœur testé non-négociable."""

from __future__ import annotations

import pytest

from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.domain.errors import LlmResponseError, LlmTransportError
from itsm_modern_ai.domain.models import Decision, Referentials, Ticket
from itsm_modern_ai.persistence import db, journal
from itsm_modern_ai.persistence.tables import LlmCall
from itsm_modern_ai.services.triage import TriageService, rules_fully_handled

REFS = Referentials(categories={1: "Compte", 2: "RH"}, technicians={11: "Syl", 12: "Nadia"})


class FakeLlm:
    def __init__(self, decision: Decision | None = None, error: Exception | None = None):
        self.calls = 0
        self._decision = decision
        self._error = error

    async def complete(self, system: str, user: str):
        self.calls += 1
        self.last_user = user
        if self._error is not None:
            raise self._error
        from itsm_modern_ai.ports.llm import LlmResult

        return LlmResult(
            decision=self._decision,
            model="fake",
            prompt_tokens=100,
            completion_tokens=20,
            raw_response=self._decision.model_dump_json(),
        )


class FakeItsm:
    def __init__(self):
        self.followups = []
        self.applied = []  # (ticket_id, category, priority, technician_id, group_id)

    async def write_followup(self, ticket_id, content, *, private=True) -> int:
        self.followups.append((ticket_id, content, private))
        return 1

    async def apply_decision(
        self, ticket_id, *, category, priority, technician_id=None, group_id=None
    ) -> None:
        self.applied.append((ticket_id, category, priority, technician_id, group_id))

    async def get_new_tickets(self):
        return []

    async def get_referentials(self):
        return REFS

    async def healthcheck(self):
        return True


def _service(llm, itsm=None, *, default_mode=None, auto_min_confidence=None, **overrides) -> TriageService:
    from itsm_modern_ai.domain.modes import ExecutionMode

    settings = Settings(glpi_base_url="https://glpi.local/apirest.php", **overrides)
    return TriageService(
        itsm=itsm or FakeItsm(),
        llm=llm,
        settings=settings,
        tech_profiles_prose="",
        session_factory=db.session_scope,
        default_mode=default_mode or ExecutionMode.SUGGESTION,
        auto_min_confidence=auto_min_confidence,
    )


def _accepted_decision() -> Decision:
    return Decision(category=1, priority=3, technician_id=11, draft="Bonjour", confidence=0.9)


async def test_accepted_writes_private_followup_and_journals(temp_db):
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm)
    wrote = await svc.handle(Ticket(id=10, content="je n'arrive plus à me connecter"), REFS)
    assert wrote is True
    assert itsm.followups and itsm.followups[0][2] is True  # privé
    assert "Suggestion de triage" in itsm.followups[0][1]
    with db.session_scope() as s:
        decisions = journal.list_decisions(s)
    assert decisions[0].accepted and decisions[0].technician_id == 11


async def test_low_confidence_goes_a_trier_no_write(temp_db):
    itsm = FakeItsm()
    d = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.4)
    svc = _service(FakeLlm(d), itsm)
    wrote = await svc.handle(Ticket(id=11, content="flou"), REFS)
    assert wrote is False and itsm.followups == []
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "low_confidence"


async def test_out_of_whitelist_technician_no_write(temp_db):
    itsm = FakeItsm()
    d = Decision(category=1, priority=3, technician_id=999, draft="x", confidence=0.95)
    svc = _service(FakeLlm(d), itsm)
    wrote = await svc.handle(Ticket(id=12, content="x"), REFS)
    assert wrote is False and itsm.followups == []
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "technician_not_in_whitelist"


async def test_invalid_llm_output_goes_a_trier(temp_db):
    svc = _service(FakeLlm(error=LlmResponseError("bad json")))
    wrote = await svc.handle(Ticket(id=13, content="x"), REFS)
    assert wrote is False
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "invalid_output"


async def test_transport_error_retried_then_a_trier(temp_db):
    llm = FakeLlm(error=LlmTransportError("net"))
    svc = _service(llm, llm_retries=1)
    wrote = await svc.handle(Ticket(id=14, content="x"), REFS)
    assert wrote is False
    assert llm.calls == 2  # 1 essai + 1 retry (FR-9)
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "llm_error"


async def test_two_stage_skips_llm_when_rules_handled(temp_db):
    llm = FakeLlm(_accepted_decision())
    svc = _service(llm)
    ticket = Ticket(id=15, content="x", category_id=3, assignee_present=True)
    assert rules_fully_handled(ticket) is True
    wrote = await svc.handle(ticket, REFS)
    assert wrote is False and llm.calls == 0  # aucun appel LLM (FR-5)


async def test_partial_match_still_goes_to_engine(temp_db):
    # Catégorie posée mais pas d'assignation → NON complètement traité (Q16).
    ticket = Ticket(id=16, content="x", category_id=3, assignee_present=False)
    assert rules_fully_handled(ticket) is False
    llm = FakeLlm(_accepted_decision())
    await _service(llm).handle(ticket, REFS)
    assert llm.calls == 1


async def test_cost_cap_blocks_llm_call(temp_db):
    # Pré-remplir des appels dépassant le plafond sur la fenêtre 24h.
    with db.session_scope() as s:
        s.add(LlmCall(ticket_id=1, model="m", cost_eur=10.0))
        s.commit()
    llm = FakeLlm(_accepted_decision())
    svc = _service(llm, cost_cap_eur_per_day=5.0)
    wrote = await svc.handle(Ticket(id=17, content="x"), REFS)
    assert wrote is False and llm.calls == 0  # plus aucun appel facturant (FR-10)
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "cost_cap_reached"


async def test_pii_masked_in_llm_log(temp_db):
    llm = FakeLlm(_accepted_decision())
    svc = _service(llm)
    await svc.handle(Ticket(id=18, content="contact jean@exemple.fr mdp: Secret123"), REFS)
    # Le prompt envoyé au LLM est masqué.
    assert "jean@exemple.fr" not in llm.last_user
    assert "Secret123" not in llm.last_user
    with db.session_scope() as s:
        call = s.get(LlmCall, 1)
    assert "jean@exemple.fr" not in call.prompt_sent and "Secret123" not in call.prompt_sent


@pytest.mark.parametrize("private", [True])
async def test_followup_is_always_private(temp_db, private):
    itsm = FakeItsm()
    await _service(FakeLlm(_accepted_decision()), itsm).handle(Ticket(id=19, content="x"), REFS)
    assert all(f[2] is True for f in itsm.followups)


# ── Modes d'exécution (FR-17) ────────────────────────────────────────────────
from itsm_modern_ai.domain.modes import ExecutionMode  # noqa: E402


async def test_suggestion_mode_never_mutates_ticket(temp_db):
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm, default_mode=ExecutionMode.SUGGESTION)
    await svc.handle(Ticket(id=20, content="x"), REFS)
    assert itsm.applied == []  # aucune mutation
    assert itsm.followups  # mais Suivi déposé
    assert "proposition, non appliquée" in itsm.followups[0][1]  # texte mode suggestion
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
    assert row.applied is False and row.mode == "suggestion"


async def test_full_auto_mutates_and_still_writes_followup(temp_db):
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm, default_mode=ExecutionMode.FULL_AUTO)
    await svc.handle(Ticket(id=21, content="x"), REFS)
    assert itsm.applied == [(21, 1, 3, 11, None)]  # cat/prio/technicien appliqués
    assert itsm.followups  # Suivi toujours écrit (audit)
    text = itsm.followups[0][1]
    assert "appliqué automatiquement" in text  # texte reflète la mutation réelle
    assert "non appliquée" not in text and "Vous gardez la main" not in text
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
    assert row.applied is True and row.mode == "full_auto"


async def test_semi_auto_applies_above_threshold_else_suggests(temp_db):
    # Confiance 0.9 ≥ seuil auto 0.85 → applique.
    itsm = FakeItsm()
    d = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9)
    svc = _service(FakeLlm(d), itsm, default_mode=ExecutionMode.SEMI_AUTO, auto_min_confidence=0.85)
    await svc.handle(Ticket(id=22, content="x"), REFS)
    assert itsm.applied  # appliqué

    # Confiance 0.8 < seuil auto 0.85 (mais ≥ seuil normal 0.7) → suggestion seule.
    itsm2 = FakeItsm()
    d2 = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.8)
    svc2 = _service(FakeLlm(d2), itsm2, default_mode=ExecutionMode.SEMI_AUTO, auto_min_confidence=0.85)
    await svc2.handle(Ticket(id=23, content="x"), REFS)
    assert itsm2.applied == [] and itsm2.followups  # pas de mutation, Suivi déposé


async def test_mode_resolved_per_entity_overrides_default(temp_db):
    # Entité 7 réglée en full_auto ; défaut global = suggestion.
    from itsm_modern_ai.persistence.tables import ReferentialCache

    with db.session_scope() as s:
        s.add(ReferentialCache(kind="entity", ext_id=7, name="E7", mode="full_auto"))
        s.commit()
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm, default_mode=ExecutionMode.SUGGESTION)
    await svc.handle(Ticket(id=24, content="x", entity_id=7), REFS)
    assert itsm.applied  # l'entité force full_auto malgré le défaut suggestion
