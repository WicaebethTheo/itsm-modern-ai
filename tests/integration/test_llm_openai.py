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
    # Borne de génération (LLM10) présente dans le payload.
    import json as _json

    from itsm_modern_ai.adapters.llm.openai_compatible import DEFAULT_MAX_TOKENS

    payload = _json.loads(sent.content)
    assert payload["max_tokens"] == DEFAULT_MAX_TOKENS


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
async def test_html_200_body_raises_response_error():
    # Portail captif / proxy renvoyant du HTML en 200 : doit devenir une LlmResponseError
    # typée (retry + « à trier »), jamais une exception brute qui re-facture en boucle.
    respx.post(URL).mock(return_value=httpx.Response(200, text="<html>Bad Gateway</html>"))
    with pytest.raises(LlmResponseError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_null_content_raises_response_error():
    # Filtre de contenu (Azure/OpenRouter) : `content: null` → LlmResponseError, pas TypeError.
    respx.post(URL).mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": None}}], "usage": None})
    )
    with pytest.raises(LlmResponseError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_null_usage_is_estimated_not_zero(caplog):
    """`usage` absent ⇒ ANOMALIE, pas gratuité (audit fiabilité 2026-08).

    L'adaptateur comptait 0 token : une passerelle sans bloc `usage` faisait avancer le
    compteur de 0,00 € indéfiniment et le plafond (FR-10) n'était JAMAIS atteint. On
    exige désormais une estimation non nulle + un warning explicite pour l'exploitant.
    """
    respx.post(URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"category":1,"priority":3,"technician_id":11,'
                                         '"draft":"ok","confidence":0.9}'}}],
                "usage": None,
            },
        )
    )
    with caplog.at_level("WARNING"):
        result = await _adapter().complete("sys", "un prompt utilisateur de taille réaliste")
    assert result.prompt_tokens > 0 and result.completion_tokens > 0
    assert "usage.prompt_tokens absent" in caplog.text
    assert "usage.completion_tokens absent" in caplog.text


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


async def test_ssrf_guard_blocks_host_resolving_to_internal_ip(monkeypatch):
    """Anti-SSRF (DNS rebinding) : avec le garde activé, un hôte qui résout vers une IP
    interne est bloqué AVANT l'émission de la requête (donc avant fuite de la clé LLM)."""
    import itsm_modern_ai.domain.url_safety as us

    monkeypatch.setattr(
        us.socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("127.0.0.1", 0))]
    )
    adapter = OpenAiCompatibleLlm(base_url=BASE, api_key="k", model="m", ssrf_guard=True)
    with pytest.raises(LlmTransportError, match="anti-SSRF"):
        await adapter.complete("sys", "user")


# ── Frontière STRICTE de la Décision (audit fiabilité 2026-08) ────────────────


@respx.mock
async def test_boolean_is_not_coerced_into_a_category():
    """`{"category": true}` donnait `category=1` : une Décision était ACCEPTÉE sur la
    catégorie #1 sans que le modèle n'en ait proposé aucune. `strict=True` referme ce
    trou — un type faux part désormais en `invalid_output`."""
    respx.post(URL).mock(
        return_value=_chat_response(
            '{"category": true, "priority": 3, "technician_id": 11, '
            '"draft": "x", "confidence": 0.9}'
        )
    )
    with pytest.raises(LlmResponseError):
        await _adapter().complete("sys", "user")


@respx.mock
async def test_numeric_strings_are_coerced_explicitly_in_the_adapter():
    """Certaines passerelles sérialisent les nombres en chaîne. La compatibilité est
    conservée, mais par une coercition EXPLICITE et bornée de l'adaptateur — plus par
    la coercition implicite (et non maîtrisée) du modèle de domaine."""
    respx.post(URL).mock(
        return_value=_chat_response(
            '{"category": "2", "priority": "3", "technician_id": "11", '
            '"draft": "x", "confidence": "0.9"}'
        )
    )
    result = await _adapter().complete("sys", "user")
    assert result.decision.category == 2 and result.decision.priority == 3
    assert result.decision.technician_id == 11 and result.decision.confidence == 0.9


@respx.mock
async def test_usage_present_but_zero_is_also_estimated(caplog):
    """`usage` présent mais à 0 est aussi une anomalie : un appel qui a produit du texte
    n'a jamais consommé zéro token. Sinon le plafond reste aveugle de la même façon."""
    respx.post(URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"category":1,"priority":3,'
                                         '"technician_id":11,"draft":"ok","confidence":0.9}'}}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
            },
        )
    )
    with caplog.at_level("WARNING"):
        result = await _adapter().complete("sys", "un prompt de taille réaliste")
    assert result.prompt_tokens > 0 and result.completion_tokens > 0
