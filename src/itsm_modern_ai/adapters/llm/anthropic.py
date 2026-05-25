"""Adaptateur LLM Anthropic (FR-12, Phase 2) — API Messages.

Anthropic n'a pas de `response_format=json_object` : on force le JSON par préremplissage
de la réponse assistant avec « { » et on reconstruit/parse le JSON. Validation Pydantic
à cette frontière (comme l'adaptateur OpenAI-compatible).

Non-souverain (hors UE) — à documenter clairement vis-à-vis de la DPO. Le défaut produit
reste Mistral EU ; Anthropic est un choix explicite de l'opérateur.
"""

from __future__ import annotations

import json

import httpx
from pydantic import ValidationError

from ...domain.errors import LlmResponseError, LlmTransportError
from ...domain.models import Decision
from ...ports.llm import LlmResult

DEFAULT_VERSION = "2023-06-01"


class AnthropicLlm:
    """Implémente `LlmPort` pour l'API Anthropic Messages."""

    def __init__(
        self,
        api_key: str,
        model: str,
        *,
        base_url: str = "https://api.anthropic.com",
        version: str = DEFAULT_VERSION,
        max_tokens: int = 1024,
        timeout: float = 60.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._version = version
        self._max_tokens = max_tokens
        self._timeout = timeout
        self._client = client

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": self._version,
            "content-type": "application/json",
        }

    async def _post(self, url: str, payload: dict) -> httpx.Response:
        if self._client is not None:
            return await self._client.post(url, json=payload, headers=self._headers())
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            return await client.post(url, json=payload, headers=self._headers())

    async def healthcheck(self) -> bool:
        url = f"{self._base_url}/v1/models"
        try:
            if self._client is not None:
                resp = await self._client.get(url, headers=self._headers())
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    resp = await client.get(url, headers=self._headers())
            return resp.status_code < 400
        except httpx.HTTPError:
            return False

    async def complete(self, system_prompt: str, user_prompt: str) -> LlmResult:
        payload = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "system": system_prompt,
            "messages": [
                {"role": "user", "content": user_prompt},
                {"role": "assistant", "content": "{"},  # préremplissage → force le JSON
            ],
        }
        try:
            resp = await self._post(f"{self._base_url}/v1/messages", payload)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise LlmTransportError(str(exc)) from exc

        body = resp.json()
        try:
            text = body["content"][0]["text"]
            usage = body.get("usage", {})
        except (KeyError, IndexError, TypeError) as exc:
            raise LlmResponseError(f"Réponse Anthropic inattendue: {exc}") from exc

        raw = "{" + text  # on a prérempli « { »
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LlmResponseError(f"JSON non parsable: {exc}") from exc

        try:
            decision = Decision.model_validate(data)
        except ValidationError as exc:
            raise LlmResponseError(f"Décision non conforme au schéma: {exc}") from exc

        return LlmResult(
            decision=decision,
            model=self._model,
            prompt_tokens=usage.get("input_tokens", 0),
            completion_tokens=usage.get("output_tokens", 0),
            raw_response=raw,
        )
