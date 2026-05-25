"""GlpiConnector (FR-1→4) avec GLPI mocké via respx — chemin critique."""

from __future__ import annotations

import httpx
import pytest
import respx

from itsm_modern_ai.adapters.itsm.glpi.connector import GlpiConnector
from itsm_modern_ai.domain.errors import ItsmUnavailableError
from itsm_modern_ai.services.runtime_config import GlpiCredentials

BASE = "https://glpi.test/apirest.php"


def _creds(**kw) -> GlpiCredentials:
    base = dict(
        base_url=BASE, user_token="utok", app_token="", verify_tls=True,
        timeout_seconds=10.0, followup_legacy_9x=False,
    )
    base.update(kw)
    return GlpiCredentials(**base)


def _session_routes():
    respx.get(f"{BASE}/initSession").mock(return_value=httpx.Response(200, json={"session_token": "S"}))
    respx.get(f"{BASE}/killSession").mock(return_value=httpx.Response(200, json={}))


async def _connector() -> GlpiConnector:
    return GlpiConnector(_creds(), http_client=httpx.AsyncClient())


@respx.mock
async def test_get_new_tickets_filters_status_new():
    _session_routes()
    respx.get(f"{BASE}/Ticket").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"id": 1, "name": "a", "content": "x", "status": 1},
                {"id": 2, "name": "b", "content": "y", "status": 2},  # Assigned → ignoré
                {"id": 3, "name": "c", "content": "z", "status": 1},
            ],
        )
    )
    tickets = await (await _connector()).get_new_tickets()
    assert [t.id for t in tickets] == [1, 3]


@respx.mock
async def test_get_referentials_builds_whitelist():
    _session_routes()
    respx.get(f"{BASE}/ITILCategory").mock(
        return_value=httpx.Response(200, json=[{"id": 1, "completename": "Compte"}])
    )
    respx.get(f"{BASE}/User").mock(
        return_value=httpx.Response(200, json=[{"id": 11, "firstname": "Syl", "realname": "Vain"}])
    )
    respx.get(f"{BASE}/Group").mock(
        return_value=httpx.Response(200, json=[{"id": 5, "completename": "Support N2"}])
    )
    respx.get(f"{BASE}/Entity").mock(
        return_value=httpx.Response(200, json=[{"id": 0, "completename": "Racine"}])
    )
    refs = await (await _connector()).get_referentials()
    assert refs.categories == {1: "Compte"}
    assert refs.technicians == {11: "Syl Vain"}
    assert refs.groups == {5: "Support N2"}
    assert refs.entities == {0: "Racine"}
    assert refs.priorities[1] == "Très basse"  # encodage statique


@respx.mock
async def test_write_followup_private_no_field_mutation():
    _session_routes()
    route = respx.post(f"{BASE}/ITILFollowup").mock(return_value=httpx.Response(201, json={"id": 99}))
    fid = await (await _connector()).write_followup(7, "Suggestion", private=True)
    assert fid == 99
    body = route.calls.last.request.content
    assert b'"items_id":7' in body and b'"is_private":1' in body
    # Aucune route Ticket PUT/POST → garantit qu'aucun champ n'est modifié.
    assert not any(c.request.url.path.endswith("/Ticket") for c in respx.calls)


@respx.mock
async def test_get_recent_tickets_parses_stats_and_window():
    import datetime as _dt

    _session_routes()
    respx.get(f"{BASE}/Ticket").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"id": 1, "status": 5, "date": "2026-05-30 09:00:00", "solvedate": "2026-05-30 10:00:00",
                 "time_to_resolve": "2026-05-30 12:00:00", "takeintoaccount_delay_stat": 300, "entities_id": 0},
                {"id": 2, "status": 1, "date": "2020-01-01 09:00:00"},  # hors fenêtre
            ],
        )
    )
    since = _dt.datetime(2026, 5, 1)
    stats = await (await _connector()).get_recent_tickets(since)
    assert [s.id for s in stats] == [1]  # le vieux ticket est filtré
    assert stats[0].first_response_seconds == 300 and stats[0].is_closed


@respx.mock
async def test_healthcheck_true_when_session_ok():
    _session_routes()
    assert await (await _connector()).healthcheck() is True


@respx.mock
async def test_healthcheck_false_on_unreachable():
    respx.get(f"{BASE}/initSession").mock(side_effect=httpx.ConnectError("down"))
    assert await (await _connector()).healthcheck() is False


@respx.mock
async def test_get_tickets_unavailable_raises_typed_error():
    respx.get(f"{BASE}/initSession").mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(ItsmUnavailableError):
        await (await _connector()).get_new_tickets()


def test_connector_requires_configured_creds():
    with pytest.raises(ItsmUnavailableError):
        GlpiConnector(_creds(base_url="", user_token=""))._client()
