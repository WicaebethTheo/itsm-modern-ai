"""Adaptateur LLM OpenAI-compatible (FR-11) — défaut Mistral EU (FR-13).

Couvre Mistral / Ollama / OpenRouter / OpenAI via un seul chemin de code.
Le changement de fournisseur se fait par config (base_url + model + clé), sans
changement de code. Utilise `response_format=json_object` (JSON mode) : portable,
pas de tool-calling spécifique.

Validation Pydantic de la sortie à CETTE frontière (architecture : validation
à la frontière adaptateur). Toute non-conformité → `LlmResponseError`.
"""

from __future__ import annotations

import json

import httpx
from pydantic import ValidationError

from ...domain.errors import LlmResponseError, LlmTransportError
from ...domain.models import Decision
from ...ports.llm import LlmResult


class OpenAiCompatibleLlm:
    """Implémente `LlmPort` pour tout endpoint compatible OpenAI chat-completions."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        timeout: float = 60.0,
        temperature: float = 0.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._temperature = temperature
        self._client = client

    async def healthcheck(self) -> bool:
        """Sonde légère (GET /models) — ne consomme pas de tokens. Best-effort."""
        url = f"{self._base_url}/models"
        headers = {"Authorization": f"Bearer {self._api_key}"}
        try:
            if self._client is not None:
                resp = await self._client.get(url, headers=headers)
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    resp = await client.get(url, headers=headers)
            return resp.status_code < 400
        except httpx.HTTPError:
            return False

    async def complete(self, system_prompt: str, user_prompt: str) -> LlmResult:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": self._temperature,
        }
        headers = {"Authorization": f"Bearer {self._api_key}"}
        url = f"{self._base_url}/chat/completions"

        try:
            if self._client is not None:
                resp = await self._client.post(url, json=payload, headers=headers)
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
        except httpx.HTTPError as exc:  # réseau, timeout, 5xx, etc. (FR-9)
            raise LlmTransportError(str(exc)) from exc

        body = resp.json()
        try:
            content = body["choices"][0]["message"]["content"]
            usage = body.get("usage", {})
        except (KeyError, IndexError, TypeError) as exc:
            raise LlmResponseError(f"Réponse LLM inattendue: {exc}") from exc

        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            raise LlmResponseError(f"JSON non parsable: {exc}") from exc

        try:
            decision = Decision.model_validate(data)
        except ValidationError as exc:
            raise LlmResponseError(f"Décision non conforme au schéma: {exc}") from exc

        return LlmResult(
            decision=decision,
            model=self._model,
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            raw_response=content,
        )
