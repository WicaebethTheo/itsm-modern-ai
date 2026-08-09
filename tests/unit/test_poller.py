"""Boucle de polling (FR-2/FR-3) : idempotence, résilience, seam handler."""

from __future__ import annotations

import pytest

from itsm_modern_ai.domain.errors import ItsmUnavailableError
from itsm_modern_ai.domain.models import Referentials, Ticket
from itsm_modern_ai.persistence import db, idempotency
from itsm_modern_ai.scheduler.poller import TriagePoller
from itsm_modern_ai.services.whitelist_cache import WhitelistCache

REFS = Referentials(categories={1: "Compte"}, technicians={11: "Syl"})


class FakeItsm:
    def __init__(self, tickets, refs=REFS, fail_referentials=False):
        self._tickets = tickets
        self._refs = refs
        self._fail_referentials = fail_referentials

    async def get_referentials(self) -> Referentials:
        if self._fail_referentials:
            raise ItsmUnavailableError("down")
        return self._refs

    async def get_new_tickets(self) -> list[Ticket]:
        return self._tickets

    async def write_followup(self, ticket_id, content, *, private=True) -> int:
        return 1

    async def healthcheck(self) -> bool:
        return True


async def test_refreshes_whitelist_and_processes_new(temp_db):
    cache = WhitelistCache()
    itsm = FakeItsm([Ticket(id=1, content="x"), Ticket(id=2, content="y")])
    stats = await TriagePoller(itsm, cache).poll_once()
    assert stats.fetched == 2 and stats.processed_new == 2
    assert cache.is_loaded and cache.referentials.categories == {1: "Compte"}


async def test_idempotent_second_poll_skips(temp_db):
    cache = WhitelistCache()
    itsm = FakeItsm([Ticket(id=1, content="x")])
    poller = TriagePoller(itsm, cache)
    await poller.poll_once()
    stats = await poller.poll_once()  # même ticket → déjà traité
    assert stats.skipped_already_done == 1 and stats.processed_new == 0


async def test_handler_invoked_for_new_tickets(temp_db):
    seen = []

    async def handler(ticket: Ticket, refs: Referentials) -> bool:
        seen.append(ticket.id)
        return True

    itsm = FakeItsm([Ticket(id=5, content="z")])
    await TriagePoller(itsm, WhitelistCache(), handler=handler).poll_once()
    assert seen == [5]


async def test_empty_scope_skips_cycle_without_consuming(temp_db):
    # Périmètre vide (aucune catégorie sélectionnée) : le cycle est sauté SANS appeler le
    # handler (pas d'appel LLM payant au rejet garanti) NI marquer les tickets traités
    # (ils restent repris une fois le périmètre configuré).
    called = []

    async def handler(ticket: Ticket, refs: Referentials) -> bool:
        called.append(ticket.id)
        return True

    empty_refs = Referentials(categories={}, technicians={11: "Syl"})
    itsm = FakeItsm([Ticket(id=1, content="x")], refs=empty_refs)
    stats = await TriagePoller(itsm, WhitelistCache(), handler=handler).poll_once()
    assert called == []  # handler jamais appelé
    assert stats.processed_new == 0 and stats.fetched == 0  # aucun ticket consommé


async def test_glpi_unavailable_no_crash_no_loss(temp_db):
    itsm = FakeItsm([Ticket(id=1, content="x")], fail_referentials=True)
    stats = await TriagePoller(itsm, WhitelistCache()).poll_once()
    # Cycle sauté proprement : rien traité, pas d'exception.
    assert stats.processed_new == 0 and stats.fetched == 0


async def test_one_ticket_error_does_not_block_others(temp_db):
    async def handler(ticket: Ticket, refs: Referentials) -> bool:
        if ticket.id == 1:
            raise RuntimeError("boom")
        return True

    itsm = FakeItsm([Ticket(id=1, content="x"), Ticket(id=2, content="y")])
    stats = await TriagePoller(itsm, WhitelistCache(), handler=handler).poll_once()
    assert stats.errors == 1 and stats.processed_new == 1


@pytest.mark.parametrize("private", [True])
async def test_followup_capability_via_fake(temp_db, private):
    itsm = FakeItsm([])
    assert await itsm.write_followup(1, "x", private=private) == 1


async def test_entity_scope_filters_tickets(temp_db):
    # Périmètre limité à l'entité 0 → le ticket de l'entité 9 est ignoré (hors périmètre).
    refs = Referentials(categories={1: "C"}, technicians={11: "T"}, entities={0: "Racine"})
    seen: list[int] = []

    async def handler(ticket: Ticket, _refs: Referentials) -> bool:
        seen.append(ticket.id)
        return True

    itsm = FakeItsm(
        [Ticket(id=1, content="x", entity_id=0), Ticket(id=2, content="y", entity_id=9)],
        refs=refs,
    )
    stats = await TriagePoller(itsm, WhitelistCache(), handler=handler).poll_once()
    assert seen == [1]
    assert stats.processed_new == 1 and stats.skipped_out_of_scope == 1


async def test_no_entity_scope_processes_all(temp_db):
    refs = Referentials(categories={1: "C"}, technicians={11: "T"})  # pas d'entités → toutes
    itsm = FakeItsm([Ticket(id=1, content="x", entity_id=7)], refs=refs)
    stats = await TriagePoller(itsm, WhitelistCache()).poll_once()
    assert stats.processed_new == 1 and stats.skipped_out_of_scope == 0


# ── Audit fiabilité 2026-08 : ne plus brûler un Ticket non trié ───────────────

from itsm_modern_ai.domain.models import HandlerOutcome, TriageReason  # noqa: E402
from itsm_modern_ai.scheduler import poller as poller_mod  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_attempts():
    """Le compteur d'essais vit au niveau module (le poller est recréé à chaque cycle)."""
    poller_mod.reset_attempts()
    yield
    poller_mod.reset_attempts()


async def test_cost_cap_does_not_consume_the_ticket(temp_db):
    """Plafond atteint → le Ticket doit rester en file (il n'a jamais été trié).

    Avant : `mark_processed` était appelé quel que soit le résultat → tous les Tickets
    de la fenêtre étaient brûlés définitivement, sans écran pour les rejouer.
    """
    async def handler(ticket, refs):
        return HandlerOutcome(retryable=True, reason=TriageReason.COST_CAP_REACHED)

    itsm = FakeItsm([Ticket(id=1, content="x")])
    poller = TriagePoller(itsm, WhitelistCache(), handler=handler)
    stats = await poller.poll_once()
    assert stats.processed_new == 0
    # Cycle suivant : le Ticket est TOUJOURS là (jamais marqué traité).
    stats2 = await poller.poll_once()
    assert stats2.skipped_already_done == 0 and stats2.fetched == 1


async def test_cost_cap_never_burns_an_attempt(temp_db):
    """Un report GRATUIT (aucun appel émis) ne doit pas consommer d'essai : sinon un
    plafond atteint quelques cycles d'affilée finirait par consommer l'arriéré."""
    async def handler(ticket, refs):
        return HandlerOutcome(retryable=True, reason=TriageReason.COST_CAP_REACHED)

    itsm = FakeItsm([Ticket(id=1, content="x")])
    poller = TriagePoller(itsm, WhitelistCache(), handler=handler)
    for _ in range(poller_mod.MAX_TRIAGE_ATTEMPTS + 3):
        await poller.poll_once()
    stats = await poller.poll_once()
    assert stats.skipped_already_done == 0  # jamais consommé


async def test_llm_error_is_retried_then_abandoned_after_bounded_attempts(temp_db):
    """Panne LLM / sortie invalide : le Ticket est rejoué… mais pas éternellement.

    Un Ticket systématiquement invalide serait re-facturé sans fin : le compteur borné
    (`MAX_TRIAGE_ATTEMPTS`) le consomme après N tentatives coûteuses, en laissant une
    ligne « à trier » par tentative au Journal.
    """
    seen: list[int] = []

    async def handler(ticket, refs):
        seen.append(ticket.id)
        return HandlerOutcome(retryable=True, costly=True, reason=TriageReason.INVALID_OUTPUT)

    itsm = FakeItsm([Ticket(id=1, content="x")])
    poller = TriagePoller(itsm, WhitelistCache(), handler=handler)
    for _ in range(poller_mod.MAX_TRIAGE_ATTEMPTS):
        await poller.poll_once()
    assert len(seen) == poller_mod.MAX_TRIAGE_ATTEMPTS  # rejoué à chaque cycle
    stats = await poller.poll_once()
    assert stats.skipped_already_done == 1  # puis abandonné (plus aucun appel facturé)
    assert len(seen) == poller_mod.MAX_TRIAGE_ATTEMPTS


async def test_successful_triage_still_marks_processed(temp_db):
    """Non-régression : un arbitrage rendu (même « à trier » pour faible confiance)
    consomme bien le Ticket — seuls les triages NON EFFECTUÉS sont reportés."""
    async def handler(ticket, refs):
        return HandlerOutcome(followup_written=True, reason=TriageReason.ACCEPTED)

    itsm = FakeItsm([Ticket(id=1, content="x")])
    poller = TriagePoller(itsm, WhitelistCache(), handler=handler)
    assert (await poller.poll_once()).processed_new == 1
    assert (await poller.poll_once()).skipped_already_done == 1


async def test_db_write_failures_trip_the_circuit_breaker(temp_db):
    """Disque plein / volume RO : `mark_processed` échoue → le Ticket est repayé à chaque
    cycle et le plafond reste aveugle (ses insertions échouent aussi). Au-delà de N échecs
    consécutifs, le cycle DOIT s'interrompre au lieu de continuer à facturer."""
    handled: list[int] = []

    async def handler(ticket, refs):
        handled.append(ticket.id)
        return HandlerOutcome(followup_written=True)

    def boom(session, ticket_id, **kw):
        raise RuntimeError("attempt to write a readonly database")

    from itsm_modern_ai.persistence import idempotency

    real = idempotency.mark_processed
    idempotency.mark_processed = boom
    try:
        tickets = [Ticket(id=i, content="x") for i in range(1, 11)]
        stats = await TriagePoller(FakeItsm(tickets), WhitelistCache(), handler=handler).poll_once()
    finally:
        idempotency.mark_processed = real
    # Le cycle est coupé : on n'a PAS appelé le handler pour les 10 tickets.
    assert len(handled) == poller_mod.MAX_CONSECUTIVE_DB_FAILURES
    assert "échecs d'écriture en base" in stats.error_message


async def test_poll_stats_are_persisted_for_observability(temp_db):
    """`PollStats` était jeté après un `logger.info` : la seule réponse à « pourquoi
    aucun ticket n'est trié ? » n'était lisible que dans `docker logs`."""
    from itsm_modern_ai.persistence import db as _db
    from itsm_modern_ai.scheduler.poller import _plain_runtime_config

    itsm = FakeItsm([Ticket(id=1, content="x"), Ticket(id=2, content="y")])
    await TriagePoller(itsm, WhitelistCache()).poll_once()
    with _db.session_scope() as s:
        cfg = _plain_runtime_config(s)
        assert cfg.get("poll_last_run_at")
        assert cfg.get_int("poll_last_fetched", -1) == 2
        assert cfg.get_int("poll_last_processed", -1) == 2
        assert cfg.get_int("poll_last_errors", -1) == 0


async def test_empty_scope_reason_is_persisted(temp_db):
    """Le symptôme n°1 (« périmètre vide ») doit être lisible sans ouvrir les logs."""
    from itsm_modern_ai.persistence import db as _db
    from itsm_modern_ai.scheduler.poller import _plain_runtime_config

    empty_refs = Referentials(categories={}, technicians={11: "Syl"})
    itsm = FakeItsm([Ticket(id=1, content="x")], refs=empty_refs)
    await TriagePoller(itsm, WhitelistCache()).poll_once()
    with _db.session_scope() as s:
        assert "Aucune catégorie" in (_plain_runtime_config(s).get("poll_last_error_message") or "")


async def test_crashing_handler_is_also_bounded(temp_db):
    """Une exception non gérée après l'appel LLM (mutation GLPI qui échoue en boucle)
    est re-facturée à chaque cycle : elle doit consommer un essai, comme un triage non
    abouti — sinon le Ticket reste éternellement dans la file."""
    calls: list[int] = []

    async def handler(ticket, refs):
        calls.append(ticket.id)
        raise RuntimeError("GLPI 500 permanent")

    itsm = FakeItsm([Ticket(id=1, content="x")])
    poller = TriagePoller(itsm, WhitelistCache(), handler=handler)
    for _ in range(poller_mod.MAX_TRIAGE_ATTEMPTS):
        await poller.poll_once()
    assert len(calls) == poller_mod.MAX_TRIAGE_ATTEMPTS
    stats = await poller.poll_once()
    assert stats.skipped_already_done == 1  # abandonné, plus aucun appel facturé
    assert len(calls) == poller_mod.MAX_TRIAGE_ATTEMPTS


# ── Fenêtre de doublon : marquage en deux temps (0.9.56) ─────────────────────────────


async def test_reservation_posee_avant_le_handler(temp_db):
    """La réservation doit exister AU MOMENT où le handler écrit dans GLPI — sinon un arrêt
    brutal juste après l'écriture laisse le Ticket rejouable, donc re-répondu publiquement."""
    vue: list[bool] = []

    async def handler(ticket, refs):
        with db.session_scope() as s:
            vue.append(idempotency.is_processed(s, ticket.id))
        return HandlerOutcome(followup_written=True, reason=TriageReason.ACCEPTED)

    poller = TriagePoller(FakeItsm([Ticket(id=1, content="x")]), WhitelistCache(), handler=handler)
    await poller.poll_once()
    assert vue == [True], "le Ticket n'était pas réservé pendant l'écriture GLPI"


async def test_interruption_en_vol_nest_pas_rejouee_mais_signalee(temp_db):
    """Simule l'arrêt brutal : réservation posée, jamais libérée. Le Ticket ne doit PAS
    repartir (pas de seconde réponse publique) et l'interruption doit être visible."""
    with db.session_scope() as s:
        idempotency.claim(s, 42)
        assert idempotency.interrupted(s) == [42]

    appels: list[int] = []

    async def handler(ticket, refs):
        appels.append(ticket.id)
        return HandlerOutcome(followup_written=True, reason=TriageReason.ACCEPTED)

    poller = TriagePoller(FakeItsm([Ticket(id=42, content="x")]), WhitelistCache(), handler=handler)
    stats = await poller.poll_once()
    assert appels == [], "un Ticket interrompu a été rejoué — risque de doublon public"
    assert stats.skipped_already_done == 1


async def test_un_triage_rejouable_rend_sa_reservation(temp_db):
    """Sans `release`, une panne LLM de trois secondes brûlerait le Ticket définitivement —
    une régression bien pire que le défaut corrigé."""
    appels: list[int] = []

    async def handler(ticket, refs):
        appels.append(ticket.id)
        return HandlerOutcome(retryable=True, costly=True, reason=TriageReason.LLM_ERROR)

    poller = TriagePoller(FakeItsm([Ticket(id=7, content="x")]), WhitelistCache(), handler=handler)
    await poller.poll_once()
    with db.session_scope() as s:
        assert not idempotency.is_processed(s, 7), "réservation non rendue : Ticket brûlé"
        assert idempotency.interrupted(s) == []
    await poller.poll_once()
    assert appels == [7, 7], "le Ticket rejouable n'a pas été repris"


async def test_cycle_abouti_ne_laisse_aucune_reservation(temp_db):
    """`mark_processed` libère la réservation : un cycle normal ne doit pas ressembler à une
    interruption, sinon l'alerte deviendrait du bruit permanent."""
    async def handler(ticket, refs):
        return HandlerOutcome(followup_written=True, reason=TriageReason.ACCEPTED)

    poller = TriagePoller(FakeItsm([Ticket(id=9, content="x")]), WhitelistCache(), handler=handler)
    await poller.poll_once()
    with db.session_scope() as s:
        assert idempotency.is_processed(s, 9)
        assert idempotency.interrupted(s) == []
