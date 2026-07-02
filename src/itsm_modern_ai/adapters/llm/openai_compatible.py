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

from ...domain.errors import LlmResponseError
from ...domain.models import Decision
from ...ports.llm import LlmResult
from ._http import arequest, healthcheck_get, make_guarded_event_hooks

# Borne de génération (LLM10 — Unbounded Consumption). La sortie attendue est un petit
# objet JSON Décision ; 1024 tokens suffisent largement et plafonnent le coût/latence en
# cas de réponse pathologique. Aligné sur l'adaptateur Anthropic (qui borne déjà à 1024).
DEFAULT_MAX_TOKENS = 1024


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
        max_tokens: int = DEFAULT_MAX_TOKENS,
        ssrf_guard: bool = False,
        allow_local: bool = False,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._temperature = temperature
        self._max_tokens = max_tokens
        # Garde anti-SSRF appliqué aux clients éphémères (cf. settings.ssrf_guard_enabled).
        self._event_hooks = make_guarded_event_hooks(guard=ssrf_guard, allow_local=allow_local)
        self._client = client

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    async def healthcheck(self) -> bool:
        """Sonde légère (GET /models) — ne consomme pas de tokens. Best-effort."""
        return await healthcheck_get(
            f"{self._base_url}/models",
            self._headers(),
            client=self._client,
            timeout=self._timeout,
            event_hooks=self._event_hooks,
        )

    async def complete(self, system_prompt: str, user_prompt: str) -> LlmResult:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": self._temperature,
            # Borne de génération (LLM10) : plafonne tokens/coût/latence — voir DEFAULT_MAX_TOKENS.
            "max_tokens": self._max_tokens,
        }
        resp = await arequest(
            "POST",
            f"{self._base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
            client=self._client,
            timeout=self._timeout,
            event_hooks=self._event_hooks,
        )

        # Un 200 dont le corps n'est PAS le JSON attendu (portail captif, filtre de contenu
        # renvoyant du HTML) doit devenir une LlmResponseError typée — sinon l'exception brute
        # échappe au pipeline (ni retry ni « à trier »), le ticket n'est jamais marqué traité
        # et l'appel LLM est **re-facturé à chaque cycle** sans que le cost cap ne le voie.
        try:
            body = resp.json()
        except ValueError as exc:
            raise LlmResponseError(f"Corps de réponse LLM non-JSON: {exc}") from exc
        try:
            content = body["choices"][0]["message"]["content"]
            usage = body.get("usage") or {}  # `"usage": null` → dict vide (pas d'AttributeError)
        except (KeyError, IndexError, TypeError) as exc:
            raise LlmResponseError(f"Réponse LLM inattendue: {exc}") from exc

        # `content: null` (filtre de contenu Azure/OpenRouter) → json.loads(None) lèverait un
        # TypeError non typé. On le rejette explicitement en LlmResponseError.
        if not isinstance(content, str):
            raise LlmResponseError(f"Contenu de réponse LLM absent ou non-textuel: {type(content).__name__}")
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
