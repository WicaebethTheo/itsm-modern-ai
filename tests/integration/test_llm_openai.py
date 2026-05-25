"""Adaptateur LLM OpenAI-compatible (FR-6/11) — parsing JSON mocké (respx).

Chemin critique : une réponse non parsable doit lever une erreur typée (→ fallback),
jamais crasher. Le payload doit demander le JSON mode.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from itsm_modern_ai.adapters.llm.openai_compatible import OpenAiCompatibleLlm
from itsm_modern_ai.domain.errors import LlmResponseError, LlmTransportError

BASE = "https://llm.test/v1"
URL = f"{BASE}/chat/completions"


def _adapter() -> OpenAiCompatibleLlm:
    return OpenAiCompatibleLlm(base_url=BASE, api_key="k", model="m")


def _chat_response(content: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 5},
        },
    )


@respx.mock
async def test_parses_valid_json_decision():
    route = respx.post(URL).mock(
        return_value=_chat_response(
            '{"category": 2, "priority": 3, "technician_id": 12, '
            '"draft": "Bonjour", "confidence": 0.82}'
        )
    )
    result = await _adapter().complete("sys", "user")
    assert route.called
    assert result.decision.category == 2
    assert result.decision.confidence == 0.82
    assert result.prompt_tokens == 12
    # JSON mode demandé.
    sent = route.calls.last.request
    assert b'"response_format"' in sent.content
    assert b"json_object" in sent.content


@respx.mock
async def test_invalid_json_raises_response_error():
    respx.post(URL).mock(return_value=_chat_response("désolé je ne sais pas"))
    with pytest.raises(LlmResponseError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_missing_field_raises_response_error():
    respx.post(URL).mock(return_value=_chat_response('{"category": 1}'))
    with pytest.raises(LlmResponseError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_extra_field_rejected():
    respx.post(URL).mock(
        return_value=_chat_response(
            '{"category":1,"priority":3,"technician_id":11,"draft":"x",'
            '"confidence":0.9,"hack":"oui"}'
        )
    )
    with pytest.raises(LlmResponseError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_http_error_raises_transport_error():
    respx.post(URL).mock(return_value=httpx.Response(500))
    with pytest.raises(LlmTransportError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_network_error_raises_transport_error():
    respx.post(URL).mock(side_effect=httpx.ConnectError("boom"))
    with pytest.raises(LlmTransportError):
        await _adapter().complete("sys", "user")
