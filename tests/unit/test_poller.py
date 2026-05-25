"""Boucle de polling (FR-2/FR-3) : idempotence, résilience, seam handler."""

from __future__ import annotations

import pytest

from itsm_modern_ai.domain.errors import ItsmUnavailableError
from itsm_modern_ai.domain.models import Referentials, Ticket
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
