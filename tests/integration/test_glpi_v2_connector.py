"""GlpiV2Connector (API haut-niveau GLPI 11, OAuth2) avec GLPI mocké via respx — Beta.

Vérifie le contrat V2 : OAuth password grant, ressources namespacées, statut/objets
imbriqués, suivi via Timeline/Followup, mutation PATCH + acteur via TeamMember.
"""

from __future__ import annotations

import datetime as _dt

import httpx
import pytest
import respx

from itsm_modern_ai.adapters.itsm.glpi.v2.client import token_endpoint
from itsm_modern_ai.adapters.itsm.glpi.v2.connector import GlpiV2Connector
from itsm_modern_ai.config.credentials import GlpiV2Credentials
from itsm_modern_ai.domain.errors import ItsmAuthError, ItsmUnavailableError

BASE = "https://glpi.test/api.php/v2.3"
TOKEN = "https://glpi.test/api.php/token"


def _creds(**kw) -> GlpiV2Credentials:
    base = dict(
        base_url=BASE, client_id="cid", client_secret="csecret",
        username="tech", password="pwd", verify_tls=True, timeout_seconds=10.0,
    )
    base.update(kw)
    return GlpiV2Credentials(**base)


def _token_route(**kw):
    return respx.post(TOKEN).mock(
        return_value=httpx.Response(200, json={"token_type": "Bearer", "expires_in": 3600,
                                               "access_token": "AT123", **kw})
    )


def _connector() -> GlpiV2Connector:
    return GlpiV2Connector(_creds(), http_client=httpx.AsyncClient())


def test_token_endpoint_strips_version():
    assert token_endpoint("https://h/api.php/v2.3") == "https://h/api.php/token"
    assert token_endpoint("https://h/api.php/v2.3/") == "https://h/api.php/token"


@respx.mock
async def test_oauth_then_get_new_tickets_filters_status_new():
    _token_route()
    respx.get(f"{BASE}/Assistance/Ticket").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"id": 1, "name": "a", "content": "x", "status": {"id": 1, "name": "New"}},
                {"id": 2, "name": "b", "content": "y", "status": {"id": 2, "name": "Assigned"}},
                {"id": 3, "name": "c", "content": "z", "status": {"id": 1, "name": "New"}},
            ],
        )
    )
    tickets = await _connector().get_new_tickets()
    assert [t.id for t in tickets] == [1, 3]
    # le jeton Bearer a bien été présenté sur l'appel ressource
    tk = [c for c in respx.calls if c.request.url.path.endswith("/Assistance/Ticket")][0]
    assert tk.request.headers["Authorization"] == "Bearer AT123"


@respx.mock
async def test_get_new_tickets_uses_dot_notation_status_filter():
    _token_route()
    route = respx.get(f"{BASE}/Assistance/Ticket").mock(return_value=httpx.Response(200, json=[]))
    await _connector().get_new_tickets()
    # status est un objet imbriqué en V2 → le filtre RSQL vise status.id
    assert route.calls.last.request.url.params.get("filter") == "status.id==1"


@respx.mock
async def test_token_request_is_form_urlencoded():
    tok = _token_route()
    respx.get(f"{BASE}/Administration/User/Me").mock(return_value=httpx.Response(200, json={"id": 1}))
    await _connector().whoami()
    treq = tok.calls.last.request
    assert treq.headers["content-type"].startswith("application/x-www-form-urlencoded")
    assert b"grant_type=password" in treq.content and b"scope=api" in treq.content


@respx.mock
async def test_nested_category_and_team_assignee():
    _token_route()
    respx.get(f"{BASE}/Assistance/Ticket").mock(
        return_value=httpx.Response(200, json=[
            {"id": 5, "name": "t", "content": "c", "status": {"id": 1},
             "category": {"id": 7, "name": "Réseau"}, "entity": {"id": 0},
             "team": [{"id": 11, "type": "User", "role": "assigned"}]},
        ])
    )
    tickets = await _connector().get_new_tickets()
    assert tickets[0].category_id == 7
    assert tickets[0].assignee_present is True


@respx.mock
async def test_get_referentials_v2():
    _token_route()
    respx.get(f"{BASE}/Dropdowns/ITILCategory").mock(
        return_value=httpx.Response(200, json=[{"id": 1, "completename": "Compte"}]))
    respx.get(f"{BASE}/Administration/User").mock(
        return_value=httpx.Response(200, json=[
            {"id": 11, "firstname": "Syl", "realname": "Vain",
             "default_profile": {"id": 6, "name": "Technician"}}]))
    respx.get(f"{BASE}/Administration/Group").mock(
        return_value=httpx.Response(200, json=[{"id": 5, "completename": "Support N2"}]))
    respx.get(f"{BASE}/Administration/Entity").mock(
        return_value=httpx.Response(200, json=[{"id": 0, "completename": "Racine"}]))
    refs = await _connector().get_referentials()
    assert refs.categories == {1: "Compte"}
    assert refs.technicians == {11: "Syl Vain"}
    assert refs.groups == {5: "Support N2"}
    assert refs.entities == {0: "Racine"}
    assert refs.technician_profiles == {11: "Technician"}  # parité legacy (profil par défaut)
    assert refs.priorities[1] == "Très basse"


@respx.mock
async def test_server_version_from_setup_config():
    _token_route()
    respx.get(f"{BASE}/Setup/Config/core/version").mock(
        return_value=httpx.Response(200, json={"context": "core", "name": "version", "value": "11.0.7"}))
    assert await _connector().server_version() == "11.0.7"


@respx.mock
async def test_server_version_none_on_error():
    _token_route()
    respx.get(f"{BASE}/Setup/Config/core/version").mock(return_value=httpx.Response(403, text="nope"))
    assert await _connector().server_version() is None


@respx.mock
async def test_write_followup_via_timeline():
    _token_route()
    route = respx.post(f"{BASE}/Assistance/Ticket/7/Timeline/Followup").mock(
        return_value=httpx.Response(201, json={"id": 99}))
    fid = await _connector().write_followup(7, "Suggestion", private=True)
    assert fid == 99
    body = route.calls.last.request.content
    assert b'"content"' in body and b'"is_private":true' in body
    # aucune mutation de champ du ticket (pas de PATCH)
    assert not any(c.request.method == "PATCH" for c in respx.calls)


@respx.mock
async def test_apply_decision_patches_and_assigns_technician():
    _token_route()
    patch = respx.patch(f"{BASE}/Assistance/Ticket/7").mock(return_value=httpx.Response(200, json={"id": 7}))
    team = respx.post(f"{BASE}/Assistance/Ticket/7/TeamMember").mock(return_value=httpx.Response(200, json={}))
    await _connector().apply_decision(7, category=3, priority=4, technician_id=11)
    pbody = patch.calls.last.request.content
    # V2 : la catégorie est un objet imbriqué {id}, pas un entier plat.
    assert b'"category":{"id":3}' in pbody and b'"priority":4' in pbody and b'"urgency":4' in pbody
    tbody = team.calls.last.request.content
    assert b'"type":"User"' in tbody and b'"id":11' in tbody and b'"role":"assigned"' in tbody


@respx.mock
async def test_apply_decision_group_fallback():
    _token_route()
    respx.patch(f"{BASE}/Assistance/Ticket/8").mock(return_value=httpx.Response(200, json={"id": 8}))
    team = respx.post(f"{BASE}/Assistance/Ticket/8/TeamMember").mock(return_value=httpx.Response(200, json={}))
    await _connector().apply_decision(8, category=1, priority=2, group_id=5)
    tbody = team.calls.last.request.content
    assert b'"type":"Group"' in tbody and b'"id":5' in tbody


@respx.mock
async def test_get_recent_tickets_window_v2():
    _token_route()
    respx.get(f"{BASE}/Assistance/Ticket").mock(
        return_value=httpx.Response(200, json=[
            # date timezone-aware (cas réel V2) — doit rester comparable à un `since` naïf.
            {"id": 1, "status": {"id": 5}, "entity": {"id": 0},
             "date_creation": "2026-05-30T09:00:00+02:00", "date_solve": "2026-05-30T10:00:00Z"},
            {"id": 2, "status": {"id": 1}, "date_creation": "2020-01-01T09:00:00+02:00"},
        ])
    )
    # `since` naïf (comme le Dashboard le fournit) — ne doit PAS lever de TypeError tz.
    stats = await _connector().get_recent_tickets(_dt.datetime(2026, 5, 1))
    assert [s.id for s in stats] == [1]
    assert stats[0].is_closed
    assert stats[0].created is not None and stats[0].created.tzinfo is None  # normalisé naïf


@respx.mock
async def test_healthcheck_true():
    _token_route()
    respx.get(f"{BASE}/Administration/User/Me").mock(return_value=httpx.Response(200, json={"id": 2}))
    assert await _connector().healthcheck() is True


@respx.mock
async def test_healthcheck_false_when_oauth_refused():
    respx.post(TOKEN).mock(return_value=httpx.Response(401, json={"error": "invalid_client"}))
    assert await _connector().healthcheck() is False


@respx.mock
async def test_oauth_refused_raises_typed_error():
    respx.post(TOKEN).mock(return_value=httpx.Response(400, json={"error": "invalid_grant"}))
    with pytest.raises(ItsmAuthError):
        await _connector().get_new_tickets()


@respx.mock
async def test_token_cached_across_calls():
    tok = _token_route()
    respx.get(f"{BASE}/Administration/User/Me").mock(return_value=httpx.Response(200, json={"id": 2}))
    c = _connector()
    async with c._client() as gc:
        await gc.get("Administration/User/Me")
        await gc.get("Administration/User/Me")
    assert tok.call_count == 1  # un seul échange OAuth pour 2 appels


@respx.mock
async def test_whoami_returns_account():
    _token_route()
    respx.get(f"{BASE}/Administration/User/Me").mock(
        return_value=httpx.Response(200, json={
            "id": 2, "firstname": "Bot", "realname": "Triage", "username": "svc",
            "emails": [{"email": "bot@corp.example"}], "default_profile": {"id": 6, "name": "Technician"},
            "picture": "a/b.jpg",
        })
    )
    ident = await _connector().whoami()
    assert ident is not None
    assert ident.account == "Bot Triage" and ident.username == "svc"
    assert ident.profile == "Technician" and ident.email == "bot@corp.example"
    assert ident.has_picture is True


@respx.mock
async def test_whoami_none_on_error():
    _token_route()
    respx.get(f"{BASE}/Administration/User/Me").mock(return_value=httpx.Response(403, text="nope"))
    assert await _connector().whoami() is None


@respx.mock
async def test_avatar_returns_image_bytes():
    _token_route()
    respx.get(f"{BASE}/Administration/User/Me/Picture").mock(
        return_value=httpx.Response(200, content=b"\x89PNG_data", headers={"content-type": "image/png"})
    )
    pic = await _connector().avatar()
    assert pic is not None
    content, ctype = pic
    assert content == b"\x89PNG_data" and ctype == "image/png"


@respx.mock
async def test_avatar_none_when_absent():
    _token_route()
    respx.get(f"{BASE}/Administration/User/Me/Picture").mock(return_value=httpx.Response(404, text="none"))
    assert await _connector().avatar() is None


def test_connector_requires_configured_creds():
    with pytest.raises(ItsmUnavailableError):
        GlpiV2Connector(_creds(base_url="", client_id=""))._client()
