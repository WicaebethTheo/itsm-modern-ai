"""Adaptateur LLM Anthropic (FR-12) — API Messages mockée (respx)."""

from __future__ import annotations

import httpx
import pytest
import respx

from itsm_modern_ai.adapters.llm.anthropic import AnthropicLlm
from itsm_modern_ai.adapters.llm.registry import build_llm
from itsm_modern_ai.domain.errors import LlmResponseError, LlmTransportError

BASE = "https://anthropic.test"
MSG = f"{BASE}/v1/messages"


def _adapter() -> AnthropicLlm:
    return AnthropicLlm(api_key="sk-ant", model="claude-sonnet-4-6", base_url=BASE)


def _msg_response(text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": 30, "output_tokens": 12},
        },
    )


@respx.mock
async def test_parses_prefilled_json_decision():
    # Préremplissage « { » → le texte renvoyé est la suite du JSON.
    route = respx.post(MSG).mock(
        return_value=_msg_response(
            '"category": 2, "priority": 3, "technician_id": 12, "draft": "Bonjour", "confidence": 0.81}'
        )
    )
    result = await _adapter().complete("sys", "user")
    assert route.called
    assert result.decision.category == 2 and result.decision.confidence == 0.81
    assert result.prompt_tokens == 30 and result.completion_tokens == 12
    sent = route.calls.last.request
    assert sent.headers["x-api-key"] == "sk-ant"
    assert sent.headers["anthropic-version"]
    assert b'"content": "{"' in sent.content or b'"content":"{"' in sent.content  # préremplissage


@respx.mock
async def test_invalid_json_raises_response_error():
    respx.post(MSG).mock(return_value=_msg_response("pas du json}"))
    with pytest.raises(LlmResponseError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_http_error_is_transport_error():
    respx.post(MSG).mock(return_value=httpx.Response(529))
    with pytest.raises(LlmTransportError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_healthcheck_uses_models_endpoint():
    respx.get(f"{BASE}/v1/models").mock(return_value=httpx.Response(200, json={"data": []}))
    assert await _adapter().healthcheck() is True


def test_registry_selects_anthropic():
    llm = build_llm(provider="anthropic", base_url=BASE, api_key="k", model="claude-sonnet-4-6")
    assert isinstance(llm, AnthropicLlm)
