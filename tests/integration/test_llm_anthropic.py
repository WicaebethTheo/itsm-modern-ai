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
async def test_parses_full_json_object_from_response():
    # Sonnet 4.6+ refuse le pré-fill assistant : on n'envoie plus que le user, l'objet
    # JSON entier doit être présent dans la réponse (le system_prompt + l'instruction
    # additionnelle l'imposent).
    route = respx.post(MSG).mock(
        return_value=_msg_response(
            '{"category": 2, "priority": 3, "technician_id": 12, "draft": "Bonjour", "confidence": 0.81}'
        )
    )
    result = await _adapter().complete("sys", "user")
    assert route.called
    assert result.decision.category == 2 and result.decision.confidence == 0.81
    assert result.prompt_tokens == 30 and result.completion_tokens == 12
    sent = route.calls.last.request
    assert sent.headers["x-api-key"] == "sk-ant"
    assert sent.headers["anthropic-version"]
    # Plus de pré-fill assistant — la conversation doit se terminer par un user message.
    assert b'"role": "assistant"' not in sent.content and b'"role":"assistant"' not in sent.content


@respx.mock
async def test_extracts_json_from_wrapped_response():
    # Tolérance : un modèle bavard peut entourer le JSON de texte ou de fences ; on
    # doit savoir extraire le premier objet équilibré (toléré tant qu'il est valide).
    respx.post(MSG).mock(
        return_value=_msg_response(
            'Voici la décision :\n```json\n{"category": 1, "priority": 4, '
            '"technician_id": 7, "draft": "ok", "confidence": 0.9}\n```'
        )
    )
    result = await _adapter().complete("sys", "user")
    assert result.decision.category == 1 and result.decision.technician_id == 7


@respx.mock
async def test_invalid_json_raises_response_error():
    respx.post(MSG).mock(return_value=_msg_response("pas du json"))
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
