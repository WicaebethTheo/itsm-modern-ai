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


def _service(
    llm, itsm=None, *, default_mode=None, auto_min_confidence=None,
    confidence_threshold=None, **overrides,
) -> TriageService:
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
        confidence_threshold=confidence_threshold,
    )


def _accepted_decision() -> Decision:
    return Decision(category=1, priority=3, technician_id=11, draft="Bonjour", confidence=0.9)


async def test_accepted_writes_private_followup_and_journals(temp_db):
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm)
    wrote = await svc.handle(
        Ticket(id=10, title="Connexion impossible", content="je n'arrive plus à me connecter"), REFS
    )
    assert wrote is True
    assert itsm.followups and itsm.followups[0][2] is True  # privé
    assert "Suggestion de triage" in itsm.followups[0][1]
    with db.session_scope() as s:
        decisions = journal.list_decisions(s)
    assert decisions[0].accepted and decisions[0].technician_id == 11
    assert decisions[0].subject == "Connexion impossible"  # titre du ticket journalisé


async def test_low_confidence_goes_a_trier_no_write(temp_db):
    itsm = FakeItsm()
    d = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.4)
    svc = _service(FakeLlm(d), itsm)
    wrote = await svc.handle(Ticket(id=11, content="flou"), REFS)
    assert wrote is False and itsm.followups == []
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "low_confidence"


async def test_runtime_confidence_threshold_is_honored(temp_db):
    """Le seuil runtime (réglé via l'UI) prime sur le défaut .env (0.7), pas ignoré.

    Décision à 0.9 : acceptée au seuil par défaut, mais doit partir « à trier » si l'admin
    relève le seuil à 0.95 depuis la console (régression : le moteur lisait le .env figé)."""
    svc = _service(FakeLlm(_accepted_decision()), confidence_threshold=0.95)
    wrote = await svc.handle(Ticket(id=77, content="x"), REFS)
    assert wrote is False
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


async def test_retry_waits_with_short_backoff(temp_db, monkeypatch):
    """FR-9 durci : un 429 n'est pas re-frappé dans la milliseconde — backoff 0.5 s puis
    1.5 s (dernier palier réutilisé au-delà), et jamais d'attente avant le 1er essai."""
    from itsm_modern_ai.services import triage as triage_mod

    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(triage_mod, "_sleep", fake_sleep)
    llm = FakeLlm(error=LlmTransportError("429 Too Many Requests"))
    svc = _service(llm, llm_retries=3)
    await svc.handle(Ticket(id=15, content="x"), REFS)
    assert llm.calls == 4  # 1 essai + 3 retries
    assert sleeps == [0.5, 1.5, 1.5]


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
    assert itsm.followups and itsm.followups[0][2] is True  # Suivi PRIVÉ (technicien)
    assert "proposition, non appliquée" in itsm.followups[0][1]  # texte mode suggestion
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
    assert row.applied is False and row.mode == "suggestion"


async def test_full_auto_mutates_and_still_writes_followup(temp_db):
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm, default_mode=ExecutionMode.FULL_AUTO)
    await svc.handle(Ticket(id=21, content="x"), REFS)
    assert itsm.applied == [(21, 1, 3, 11, None)]  # cat/prio/technicien appliqués
    assert itsm.followups  # réponse écrite
    tid, content, private = itsm.followups[0]
    assert private is False  # PUBLIC → visible par le demandeur (l'IA répond)
    assert content == "Bonjour"  # brouillon seul, sans annotation de triage
    assert "Triage" not in content and "Confiance" not in content
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
    assert row.applied is True and row.mode == "full_auto"


async def test_public_draft_is_remasked_in_auto_mode(temp_db):
    # Le brouillon LLM (mode full_auto, posté PUBLIQUEMENT) peut contenir une PII non
    # détectée à l'entrée. Il DOIT être re-masqué avant publication au demandeur.
    itsm = FakeItsm()
    d = Decision(
        category=1, priority=3, technician_id=11,
        draft="Bonjour, mot de passe: Secret123 et email jean@exemple.fr",
        confidence=0.95,
    )
    svc = _service(FakeLlm(d), itsm, default_mode=ExecutionMode.FULL_AUTO)
    await svc.handle(Ticket(id=27, content="x"), REFS)
    tid, content, private = itsm.followups[0]
    assert private is False  # public
    assert "Secret123" not in content  # secret re-masqué
    assert "jean@exemple.fr" not in content  # email re-masqué


async def test_public_draft_length_is_bounded(temp_db):
    from itsm_modern_ai.services.triage import PUBLIC_DRAFT_MAX_CHARS

    itsm = FakeItsm()
    d = Decision(
        category=1, priority=3, technician_id=11, draft="A" * (PUBLIC_DRAFT_MAX_CHARS + 500),
        confidence=0.95,
    )
    svc = _service(FakeLlm(d), itsm, default_mode=ExecutionMode.FULL_AUTO)
    await svc.handle(Ticket(id=28, content="x"), REFS)
    _, content, _ = itsm.followups[0]
    assert len(content) <= PUBLIC_DRAFT_MAX_CHARS + 1  # borné (+1 pour l'ellipse)


async def test_semi_auto_applies_above_threshold_else_suggests(temp_db):
    # Confiance 0.9 ≥ seuil auto 0.85 → applique.
    itsm = FakeItsm()
    d = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9)
    svc = _service(FakeLlm(d), itsm, default_mode=ExecutionMode.SEMI_AUTO, auto_min_confidence=0.85)
    await svc.handle(Ticket(id=22, content="x"), REFS)
    assert itsm.applied and itsm.followups[0][2] is False  # appliqué → réponse publique

    # Confiance 0.8 < seuil auto 0.85 (mais ≥ seuil normal 0.7) → suggestion seule.
    itsm2 = FakeItsm()
    d2 = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.8)
    svc2 = _service(FakeLlm(d2), itsm2, default_mode=ExecutionMode.SEMI_AUTO, auto_min_confidence=0.85)
    await svc2.handle(Ticket(id=23, content="x"), REFS)
    assert itsm2.applied == []  # pas de mutation
    assert itsm2.followups and itsm2.followups[0][2] is True  # Suivi privé annoté


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


# ── Routage GROUPE (fallback FR-7) ───────────────────────────────────────────


def _group_refs() -> Referentials:
    # Pas de technicien éligible : seul un groupe peut router la Décision.
    return Referentials(categories={1: "Compte"}, groups={20: "Support N1"})


def _group_decision() -> Decision:
    return Decision(
        category=1, priority=3, technician_id=None, group_id=20, draft="bonjour", confidence=0.9
    )


async def test_group_routing_writes_followup_and_applies_in_full_auto(temp_db):
    # Décision routée vers un GROUPE (technician_id=None) en mode full_auto : la
    # mutation GLPI doit propager `group_id`, et le Suivi public être posté.
    itsm = FakeItsm()
    svc = _service(FakeLlm(_group_decision()), itsm, default_mode=ExecutionMode.FULL_AUTO)
    await svc.handle(Ticket(id=25, content="x"), _group_refs())
    assert itsm.applied == [(25, 1, 3, None, 20)]  # group_id transmis
    assert len(itsm.followups) == 1 and itsm.followups[0][2] is False  # public
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
    assert row.group_id == 20 and row.applied is True


async def test_group_routing_accepted_in_suggestion_mode(temp_db):
    # Même Décision mais en suggestion : aucune mutation, Suivi privé annoté.
    itsm = FakeItsm()
    svc = _service(FakeLlm(_group_decision()), itsm, default_mode=ExecutionMode.SUGGESTION)
    await svc.handle(Ticket(id=26, content="x"), _group_refs())
    assert itsm.applied == []  # aucune mutation GLPI
    assert itsm.followups and itsm.followups[0][2] is True  # Suivi privé


async def test_ineligible_technician_is_dropped_not_applied(temp_db):
    # SÉCURITÉ (FR-7) : le LLM propose un technicien HORS whitelist (#999) À CÔTÉ d'un
    # groupe éligible (#20). check() accepte (un acteur éligible), mais GLPI ne doit
    # JAMAIS recevoir l'utilisateur 999 — seul le groupe est appliqué, et le Journal
    # reflète le MÊME acteur (pas de trou d'audit / contournement par prompt-injection).
    refs = Referentials(categories={1: "Compte"}, technicians={11: "Syl"}, groups={20: "N1"})
    d = Decision(category=1, priority=3, technician_id=999, group_id=20, draft="x", confidence=0.95)
    itsm = FakeItsm()
    svc = _service(FakeLlm(d), itsm, default_mode=ExecutionMode.FULL_AUTO)
    await svc.handle(Ticket(id=30, content="x"), refs)
    # technician_id=None dans la mutation (999 filtré), group_id=20 appliqué.
    assert itsm.applied == [(30, 1, 3, None, 20)]
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
    assert row.group_id == 20 and row.applied is True


async def test_followup_failure_after_apply_still_journals(temp_db):
    # M1 : si la mutation GLPI réussit mais l'écriture du Suivi échoue, la décision DOIT
    # tout de même être journalisée (applied=True) — sinon trou d'audit + le ticket non
    # marqué serait re-muté au cycle suivant (doublon de réponse publique).
    class FailingFollowupItsm(FakeItsm):
        async def write_followup(self, ticket_id, content, *, private=True) -> int:
            raise RuntimeError("GLPI followup 500")

    itsm = FailingFollowupItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm, default_mode=ExecutionMode.FULL_AUTO)
    wrote = await svc.handle(Ticket(id=31, content="x"), REFS)
    assert wrote is False  # aucun Suivi écrit
    assert itsm.applied  # mais la mutation a bien eu lieu
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
    assert row.applied is True  # journalisé malgré l'échec du Suivi


async def test_cost_cap_blocks_subsequent_tickets_same_day(temp_db):
    # Le cap, atteint au 1er ticket, bloque AUSSI les Tickets suivants sur la
    # même fenêtre 24h (aucun appel LLM facturant n'est lancé).
    with db.session_scope() as s:
        s.add(LlmCall(ticket_id=1, model="m", cost_eur=10.0))
        s.commit()
    llm = FakeLlm(_accepted_decision())
    svc = _service(llm, cost_cap_eur_per_day=5.0)

    wrote1 = await svc.handle(Ticket(id=100, content="x"), REFS)
    assert wrote1 is False and llm.calls == 0

    wrote2 = await svc.handle(Ticket(id=101, content="y"), REFS)
    assert wrote2 is False and llm.calls == 0  # 2e ticket bloqué aussi

    with db.session_scope() as s:
        rows = journal.list_decisions(s)
    assert len(rows) == 2
    assert all(r.reason == "cost_cap_reached" for r in rows)


class _StubAdvancedMasker:
    """Masker Supporter factice : masque un motif que le masque de base ne couvre pas."""

    def mask(self, text: str) -> str:
        return text.replace("MATR-42", "[MATR]")


async def test_advanced_masker_applied_after_base(temp_db):
    """Le masker Supporter (FEATURE_PII_ADVANCED) est appliqué APRÈS le masque de base
    sur le texte envoyé au LLM (NIR/SIRET/regex custom)."""
    llm = FakeLlm(decision=_accepted_decision())
    svc = TriageService(
        itsm=FakeItsm(),
        llm=llm,
        settings=Settings(glpi_base_url="https://glpi.local/apirest.php"),
        tech_profiles_prose="",
        session_factory=db.session_scope,
        advanced_masker=_StubAdvancedMasker(),
    )
    await svc.evaluate_text(1, "Dossier MATR-42 à traiter", REFS)
    assert "MATR-42" not in llm.last_user
    assert "[MATR]" in llm.last_user


async def test_no_advanced_masker_in_community(temp_db):
    """Sans masker Supporter (licence absente), le texte n'est pas masqué au-delà du base."""
    llm = FakeLlm(decision=_accepted_decision())
    svc = TriageService(
        itsm=FakeItsm(),
        llm=llm,
        settings=Settings(glpi_base_url="https://glpi.local/apirest.php"),
        tech_profiles_prose="",
        session_factory=db.session_scope,
    )
    await svc.evaluate_text(1, "Dossier MATR-42 à traiter", REFS)
    assert "MATR-42" in llm.last_user


def test_render_followup_escapes_untrusted_llm_draft():
    """Sécurité : le brouillon LLM (potentiellement prompt-injecté) est échappé HTML
    avant dépôt en Suivi GLPI, en mode public (appliqué) ET privé (suggestion)."""
    from itsm_modern_ai.domain.models import TriageOutcome, TriageReason
    from itsm_modern_ai.services.triage import render_followup

    evil = '<img src=x onerror=alert(document.cookie)> <script>steal()</script>'
    d = Decision(category=1, priority=3, technician_id=11, draft=evil, confidence=0.95)
    outcome = TriageOutcome(accepted=True, reason=TriageReason.ACCEPTED, decision=d)

    public = render_followup(outcome, REFS, applied=True)
    private = render_followup(outcome, REFS, applied=False)
    for content in (public, private):
        assert "<script>" not in content and "<img" not in content
        assert "&lt;script&gt;" in content  # le markup est neutralisé, pas perdu
