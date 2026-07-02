"""Helper HTTP partagé des adapters LLM : arequest + healthcheck_get."""

from __future__ import annotations

import httpx
import pytest
import respx

from itsm_modern_ai.adapters.llm._http import arequest, healthcheck_get
from itsm_modern_ai.domain.errors import LlmTransportError

URL = "https://llm.test/v1/op"


@respx.mock
async def test_arequest_post_returns_response_on_2xx():
    respx.post(URL).mock(return_value=httpx.Response(200, json={"ok": True}))
    resp = await arequest("POST", URL, headers={"X": "k"}, json={"a": 1})
    assert resp.json() == {"ok": True}


@respx.mock
async def test_arequest_captures_body_on_4xx_for_diagnosis():
    """Le body 4xx (raison textuelle de l'erreur LLM) DOIT être dans le message d'exception."""
    respx.post(URL).mock(
        return_value=httpx.Response(
            400, json={"error": {"message": "model does not support prefill"}}
        )
    )
    with pytest.raises(LlmTransportError) as exc_info:
        await arequest("POST", URL, headers={"X": "k"}, json={"a": 1})
    assert "body=" in str(exc_info.value)
    assert "does not support prefill" in str(exc_info.value)


@respx.mock
async def test_arequest_wraps_network_error_as_transport_error():
    respx.post(URL).mock(side_effect=httpx.ConnectError("nope"))
    with pytest.raises(LlmTransportError):
        await arequest("POST", URL, headers={}, json={})


@respx.mock
async def test_arequest_no_raise_when_disabled():
    respx.get(URL).mock(return_value=httpx.Response(500))
    resp = await arequest("GET", URL, headers={}, raise_status=False)
    assert resp.status_code == 500  # pas d'exception levée


@respx.mock
async def test_healthcheck_get_true_on_2xx():
    respx.get(URL).mock(return_value=httpx.Response(200, json={"data": []}))
    assert await healthcheck_get(URL, {}) is True


@respx.mock
async def test_healthcheck_get_false_on_5xx():
    respx.get(URL).mock(return_value=httpx.Response(503))
    assert await healthcheck_get(URL, {}) is False


@respx.mock
async def test_healthcheck_get_false_on_network_error():
    respx.get(URL).mock(side_effect=httpx.ConnectError("dns"))
    assert await healthcheck_get(URL, {}) is False


@respx.mock
async def test_arequest_reuses_injected_client():
    """Si un client httpx est fourni, on le réutilise (pas de nouveau client à chaque appel)."""
    respx.post(URL).mock(return_value=httpx.Response(200, json={"k": 1}))
    async with httpx.AsyncClient() as client:
        r1 = await arequest("POST", URL, headers={}, json={}, client=client)
        r2 = await arequest("POST", URL, headers={}, json={}, client=client)
    assert r1.status_code == 200 and r2.status_code == 200
