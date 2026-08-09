"""Pipeline de triage (FR-5→10, 14, 17, 18) — cœur testé non-négociable."""

from __future__ import annotations

import pytest
from sqlmodel import select

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
    wrote = (await svc.handle(
        Ticket(id=10, title="Connexion impossible", content="je n'arrive plus à me connecter"), REFS
    )).followup_written
    assert wrote is True
    assert itsm.followups and itsm.followups[0][2] is True  # privé
    assert "Suggestion de triage" in itsm.followups[0][1]
    with db.session_scope() as s:
        decisions = journal.list_decisions(s)
    assert decisions[0].accepted and decisions[0].technician_id == 11
    assert decisions[0].subject == "Connexion impossible"  # titre du ticket journalisé


async def test_low_confidence_goes_a_trier_without_mutating(temp_db):
    """« à trier » ne MUTE rien — mais dépose désormais un Suivi privé « non tranché ».

    Historiquement ce test exigeait `followups == []`. C'était précisément le trou corrigé
    en 0.9.50 : le Ticket ne recevait RIEN dans GLPI et n'était jamais rejoué. L'invariant
    réel — aucune écriture de CHAMP sans garde-fou — est ce qui est vérifié ici."""
    itsm = FakeItsm()
    d = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.4)
    svc = _service(FakeLlm(d), itsm)
    wrote = (await svc.handle(Ticket(id=11, content="flou"), REFS)).followup_written
    assert wrote is True
    assert itsm.applied == []  # AUCUNE mutation : le garde-fou a refusé
    ticket_id, content, private = itsm.followups[0]
    assert (ticket_id, private) == (11, True)  # privé, jamais visible du demandeur
    assert "NON TRANCHÉ" in content
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "low_confidence"


async def test_runtime_confidence_threshold_is_honored(temp_db):
    """Le seuil runtime (réglé via l'UI) prime sur le défaut .env (0.7), pas ignoré.

    Décision à 0.9 : acceptée au seuil par défaut, mais doit partir « à trier » si l'admin
    relève le seuil à 0.95 depuis la console (régression : le moteur lisait le .env figé)."""
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm, confidence_threshold=0.95)
    await svc.handle(Ticket(id=77, content="x"), REFS)
    assert itsm.applied == []
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "low_confidence"
    # Le seuil RUNTIME (0.95), pas celui du .env, doit apparaître dans le Suivi : c'est ce
    # qui permet au technicien de comprendre pourquoi 90 % n'a pas suffi.
    assert "90%, seuil requis 95%" in itsm.followups[0][1]


async def test_out_of_whitelist_technician_not_applied(temp_db):
    itsm = FakeItsm()
    d = Decision(category=1, priority=3, technician_id=999, draft="x", confidence=0.95)
    svc = _service(FakeLlm(d), itsm)
    await svc.handle(Ticket(id=12, content="x"), REFS)
    assert itsm.applied == []  # l'acteur hors périmètre n'est JAMAIS assigné (FR-7)
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "technician_not_in_whitelist"
    # Le Suivi NOMME l'ID refusé et l'étiquette : c'est ce qui dit à l'admin quel acteur
    # rendre éligible — mais il ne doit jamais passer pour une affectation validée.
    assert "Technicien #999 — hors du périmètre autorisé" in itsm.followups[0][1]


async def test_invalid_llm_output_goes_a_trier(temp_db):
    svc = _service(FakeLlm(error=LlmResponseError("bad json")))
    wrote = (await svc.handle(Ticket(id=13, content="x"), REFS)).followup_written
    assert wrote is False
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "invalid_output"


async def test_transport_error_retried_then_a_trier(temp_db):
    llm = FakeLlm(error=LlmTransportError("net"))
    svc = _service(llm, llm_retries=1)
    wrote = (await svc.handle(Ticket(id=14, content="x"), REFS)).followup_written
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
    wrote = (await svc.handle(ticket, REFS)).followup_written
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
    wrote = (await svc.handle(Ticket(id=17, content="x"), REFS)).followup_written
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
    wrote = (await svc.handle(Ticket(id=31, content="x"), REFS)).followup_written
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

    wrote1 = (await svc.handle(Ticket(id=100, content="x"), REFS)).followup_written
    assert wrote1 is False and llm.calls == 0

    wrote2 = (await svc.handle(Ticket(id=101, content="y"), REFS)).followup_written
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


# ── Audit fiabilité 2026-08 : comptabilité des appels ÉCHOUÉS (FR-10/FR-19) ───


async def test_failed_llm_calls_are_journaled_and_cost_something(temp_db):
    """Un appel rejeté au parsing a QUAND MÊME été facturé (tokens générés puis jetés).

    Avant : `_journal_llm_call` n'était appelé que si une `LlmResult` revenait → 0 ligne
    en base malgré N appels réels, donc `is_over_cap` éternellement False. On exige une
    ligne PAR TENTATIVE, marquée en échec, et un coût strictement positif.
    """
    from itsm_modern_ai.services.triage import LLM_FAILURE_PREFIX

    llm = FakeLlm(error=LlmResponseError("bad json"))
    svc = _service(llm, llm_retries=2)
    res = await svc.handle(Ticket(id=200, content="un ticket bien réel à trier"), REFS)
    assert llm.calls == 3  # 1 essai + 2 retries, tous partis chez le fournisseur
    with db.session_scope() as s:
        calls = list(s.exec(select(LlmCall)).all())
    assert len(calls) == 3  # une ligne par tentative facturée
    assert all(c.response_received.startswith(LLM_FAILURE_PREFIX) for c in calls)
    assert all(c.prompt_tokens > 0 and c.completion_tokens == 0 for c in calls)
    assert sum(c.cost_eur for c in calls) > 0  # le plafond peut enfin avancer
    assert res.retryable is True and res.costly is True


async def test_cost_cap_becomes_effective_after_repeated_llm_failures(temp_db):
    """Bout en bout : des échecs LLM à répétition finissent par DÉCLENCHER le plafond.

    C'est le défaut mesuré (150 appels réels, plafond jamais atteint) : le coût des
    tentatives échouées doit s'accumuler jusqu'à couper les appels suivants.
    """
    llm = FakeLlm(error=LlmTransportError("net"))
    svc = _service(
        llm, llm_retries=0, cost_cap_eur_per_day=0.0001,
        llm_price_input_per_mtok=1000.0, llm_price_output_per_mtok=1000.0,
    )
    await svc.handle(Ticket(id=201, content="x" * 500), REFS)
    assert llm.calls == 1
    res = await svc.handle(Ticket(id=202, content="x" * 500), REFS)
    assert llm.calls == 1  # 2e ticket : plus aucun appel, le plafond a mordu
    assert res.reason.value == "cost_cap_reached"


async def test_successful_call_after_a_failed_retry_journals_both(temp_db):
    """Une tentative échouée SUIVIE d'un succès reste facturée : elle doit apparaître."""
    class FlakyLlm(FakeLlm):
        async def complete(self, system, user):
            self.calls += 1
            self.last_user = user
            if self.calls == 1:
                raise LlmTransportError("429")
            from itsm_modern_ai.ports.llm import LlmResult

            return LlmResult(decision=_accepted_decision(), model="fake",
                             prompt_tokens=100, completion_tokens=20, raw_response="{}")

    svc = _service(FlakyLlm(_accepted_decision()), llm_retries=1)
    await svc.handle(Ticket(id=203, content="x"), REFS)
    with db.session_scope() as s:
        calls = list(s.exec(select(LlmCall)).all())
    assert len(calls) == 2  # l'échec ET le succès


async def test_cost_cap_unreadable_blocks_llm_calls(temp_db):
    """Base en échec → plafond non vérifiable → défaut SÛR : aucun appel facturant.

    Sans ça, une base en lecture seule rendait le cap aveugle et le moteur facturait
    en boucle à chaque cycle.
    """
    from contextlib import contextmanager

    @contextmanager
    def broken_session():
        raise RuntimeError("database is locked")
        yield  # pragma: no cover

    llm = FakeLlm(_accepted_decision())
    svc = TriageService(
        itsm=FakeItsm(), llm=llm,
        settings=Settings(glpi_base_url="https://glpi.local/apirest.php"),
        tech_profiles_prose="", session_factory=broken_session,
    )
    res = await svc.handle(Ticket(id=204, content="x"), REFS)
    assert llm.calls == 0
    assert res.retryable is True and res.db_error is True and res.costly is False


# ── Audit fiabilité 2026-08 : Journal protégé + mutation partielle ────────────


async def test_decision_journal_failure_does_not_crash_the_handler(temp_db):
    """L'échec de `journal.record_decision` était le seul point non protégé : il rouvrait
    la fenêtre de crash (Ticket non marqué → suggestion dupliquée + appel LLM re-facturé).
    """
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm)

    real_record = journal.record_decision

    def boom(*a, **kw):
        raise RuntimeError("disk full")

    journal.record_decision = boom
    try:
        res = await svc.handle(Ticket(id=210, content="x"), REFS)
    finally:
        journal.record_decision = real_record
    assert itsm.followups  # le Suivi a bien été déposé
    assert res.db_error is True and res.retryable is False  # marqué traité, pas de doublon


async def test_partial_glpi_mutation_is_journaled_and_not_replayed(temp_db):
    """GLPI V2 fait DEUX appels : si le second échoue, le Ticket est DÉJÀ muté.

    Avant : exception brute → zéro ligne au Journal, Ticket non marqué → re-muté et
    re-facturé à chaque cycle. Après : Décision journalisée + annotée, Ticket consommé.
    """
    class PartialError(RuntimeError):
        partial_mutation = True

    class PartialItsm(FakeItsm):
        async def apply_decision(self, ticket_id, *, category, priority,
                                 technician_id=None, group_id=None):
            self.applied.append((ticket_id, category, priority, technician_id, group_id))
            raise PartialError("TeamMember 500")

    itsm = PartialItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm, default_mode=ExecutionMode.FULL_AUTO)
    res = await svc.handle(Ticket(id=211, content="x"), REFS)
    assert itsm.followups == []  # aucun Suivi public sur un état incohérent
    assert res.retryable is False  # NON-BOUCLANT : le ticket est consommé
    with db.session_scope() as s:
        row = journal.list_decisions(s)[0]
    assert row.applied is True  # OBSERVABLE : GLPI a bougé, le Journal le dit
    assert "PARTIELLE" in row.annotation


# ── Suivi « non tranché » sur « à trier » (0.9.50) ───────────────────────────────────
# Le trou corrigé : un Ticket refusé par le garde-fou ne recevait RIEN dans GLPI et n'était
# jamais rejoué — il restait « Nouveau », indistinguable d'un Ticket jamais examiné.


async def test_fallback_followup_never_carries_the_llm_draft(temp_db):
    """Le brouillon est EXCLU du Suivi « non tranché » — choix de conception, pas un oubli.

    Une confiance sous le seuil est basse sur l'ENSEMBLE de la Décision. Afficher un
    brouillon qu'un technicien pressé copierait-collerait réintroduirait par l'affichage
    la Décision que le garde-fou vient de refuser."""
    itsm = FakeItsm()
    d = Decision(
        category=1, priority=3, technician_id=11,
        draft="Bonjour, réinitialisez votre mot de passe SECRET-BROUILLON.", confidence=0.4,
    )
    await _service(FakeLlm(d), itsm).handle(Ticket(id=300, content="x"), REFS)
    content = itsm.followups[0][1]
    assert "SECRET-BROUILLON" not in content
    assert "Brouillon" not in content


@pytest.mark.parametrize(
    "error, attendu",
    [
        (LlmTransportError("réseau"), "llm_error"),
        (LlmResponseError("json"), "invalid_output"),
    ],
)
async def test_retryable_reasons_write_no_followup(temp_db, error, attendu):
    """Le piège à éviter : le triage N'A PAS EU LIEU → le Ticket revient au cycle suivant.

    Y déposer un Suivi produirait une annotation par cycle sur une coupure réseau de trois
    secondes, puis un doublon au rejeu réussi."""
    itsm = FakeItsm()
    res = await _service(FakeLlm(error=error), itsm).handle(Ticket(id=301, content="x"), REFS)
    assert itsm.followups == [] and itsm.applied == []
    assert res.retryable is True  # le Ticket n'est PAS consommé
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == attendu


async def test_cost_cap_writes_no_followup(temp_db):
    """Même famille : plafond atteint = aucun arbitrage rendu, le Ticket est rejouable."""
    itsm = FakeItsm()
    svc = _service(FakeLlm(_accepted_decision()), itsm, cost_cap_eur_per_day=0.0000001)
    with db.session_scope() as s:
        journal.record_llm_call(
            s, ticket_id=1, model="m", prompt_sent="p", response_received="r",
            prompt_tokens=1, completion_tokens=1, cost_eur=10.0,
        )
    res = await svc.handle(Ticket(id=302, content="x"), REFS)
    assert itsm.followups == [] and res.retryable is True


async def test_fallback_followup_is_written_in_full_auto_too(temp_db):
    """Le trou existait dans les TROIS modes : c'est en full-auto qu'il est le plus grave
    (une instance présentée comme automatique laissait 35 % du flux sans aucune trace)."""
    itsm = FakeItsm()
    d = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.4)
    svc = _service(FakeLlm(d), itsm, default_mode=ExecutionMode.FULL_AUTO)
    await svc.handle(Ticket(id=303, content="x"), REFS)
    assert itsm.applied == []  # full-auto ne contourne pas le garde-fou
    assert itsm.followups[0][2] is True  # PRIVÉ : le demandeur ne voit jamais un non-arbitrage
    assert "NON TRANCHÉ" in itsm.followups[0][1]


async def test_fallback_followup_labels_out_of_scope_category(temp_db):
    """Une valeur hors périmètre est rendue, mais ÉTIQUETÉE : elle ne doit pas être lue
    comme validée par le garde-fou."""
    itsm = FakeItsm()
    d = Decision(category=999, priority=3, technician_id=11, draft="x", confidence=0.95)
    await _service(FakeLlm(d), itsm).handle(Ticket(id=304, content="x"), REFS)
    content = itsm.followups[0][1]
    assert "#999 — hors du périmètre autorisé" in content
    assert "catégorie envisagée hors du périmètre autorisé" in content


async def test_fallback_followup_when_llm_proposed_nothing(temp_db):
    """`category=None` (le modèle exprime son doute) ne doit pas casser le rendu."""
    itsm = FakeItsm()
    d = Decision(category=None, priority=3, technician_id=None, draft="x", confidence=0.9)
    await _service(FakeLlm(d), itsm).handle(Ticket(id=305, content="x"), REFS)
    content = itsm.followups[0][1]
    assert "aucune (le modèle n'a pas tranché)" in content
    assert "aucun (le modèle n'a proposé ni technicien ni groupe)" in content


async def test_fallback_followup_failure_still_journals_and_consumes(temp_db):
    """Le Suivi est un acte SECONDAIRE : un GLPI en panne ne doit ni faire remonter une
    exception, ni empêcher la journalisation, ni rendre le Ticket rejouable (il serait
    re-facturé à chaque cycle)."""
    class BrokenItsm(FakeItsm):
        async def write_followup(self, ticket_id, content, *, private=True) -> int:
            raise RuntimeError("GLPI 500")

    itsm = BrokenItsm()
    d = Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.4)
    res = await _service(FakeLlm(d), itsm).handle(Ticket(id=306, content="x"), REFS)
    assert res.followup_written is False and res.retryable is False and res.db_error is False
    with db.session_scope() as s:
        assert journal.list_decisions(s)[0].reason == "low_confidence"
