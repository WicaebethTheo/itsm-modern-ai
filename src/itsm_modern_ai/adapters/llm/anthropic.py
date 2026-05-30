"""Adaptateur LLM Anthropic (FR-12, Phase 2) — API Messages.

Anthropic n'a pas de `response_format=json_object`. Les modèles ≤ Sonnet 4.5 acceptaient
un préremplissage assistant `"{"` pour forcer le JSON ; depuis Sonnet 4.6, c'est **refusé**
("The conversation must end with a user message"). On contourne :
- on demande explicitement le JSON dans le user_prompt (le system_prompt l'exige déjà) ;
- on extrait le premier objet JSON équilibré dans la réponse (tolère un wrapper texte).
Validation Pydantic à la frontière (comme l'adaptateur OpenAI-compatible).

Non-souverain (hors UE) — à documenter clairement vis-à-vis de la DPO. Le défaut produit
reste Mistral EU ; Anthropic est un choix explicite de l'opérateur.
"""

from __future__ import annotations

import json
import logging

import httpx
from pydantic import ValidationError

from ...domain.errors import LlmResponseError
from ...domain.models import Decision
from ...ports.llm import LlmResult
from ._http import arequest, healthcheck_get, make_guarded_event_hooks

logger = logging.getLogger("itsm.llm.anthropic")

DEFAULT_VERSION = "2023-06-01"


def _extract_first_json_object(text: str) -> str:
    """Extrait le premier objet `{...}` équilibré dans `text` (ignore les `{}` en chaîne).

    Tolérant aux modèles qui encadrent leur sortie d'un fence Markdown ou d'un préambule.
    Lève `ValueError` si aucun objet équilibré n'est trouvé.
    """
    start = text.find("{")
    if start == -1:
        raise ValueError("aucun '{' dans la réponse")
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise ValueError("aucun objet JSON équilibré dans la réponse")


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
        ssrf_guard: bool = False,
        allow_local: bool = False,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._version = version
        self._max_tokens = max_tokens
        self._timeout = timeout
        self._event_hooks = make_guarded_event_hooks(guard=ssrf_guard, allow_local=allow_local)
        self._client = client

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": self._version,
            "content-type": "application/json",
        }

    async def healthcheck(self) -> bool:
        return await healthcheck_get(
            f"{self._base_url}/v1/models",
            self._headers(),
            client=self._client,
            timeout=self._timeout,
            event_hooks=self._event_hooks,
        )

    async def complete(self, system_prompt: str, user_prompt: str) -> LlmResult:
        # Pas de pré-fill assistant (refusé par Sonnet 4.6+). On rappelle l'exigence JSON
        # juste avant la fin du tour utilisateur — le system_prompt l'impose déjà ; ceci
        # est une ceinture supplémentaire pour les modèles bavards.
        user_with_format = (
            f"{user_prompt}\n\n"
            "Réponds UNIQUEMENT par un objet JSON valide conforme au schéma. "
            "Pas de texte avant ni après, pas de fence Markdown."
        )
        payload = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_with_format}],
        }
        resp = await arequest(
            "POST",
            f"{self._base_url}/v1/messages",
            headers=self._headers(),
            json=payload,
            client=self._client,
            timeout=self._timeout,
            event_hooks=self._event_hooks,
        )

        body = resp.json()
        try:
            text = body["content"][0]["text"]
            usage = body.get("usage", {})
        except (KeyError, IndexError, TypeError) as exc:
            raise LlmResponseError(f"Réponse Anthropic inattendue: {exc}") from exc

        # Extraction tolérante (premier objet JSON équilibré) → robuste à un fence Markdown
        # ou un préambule. Le system_prompt + l'instruction utilisateur visent du JSON pur.
        try:
            raw = _extract_first_json_object(text)
        except ValueError as exc:
            raise LlmResponseError(f"Aucun objet JSON dans la réponse: {exc}") from exc
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LlmResponseError(f"JSON non parsable: {exc}") from exc

        try:
            decision = Decision.model_validate(data)
        except ValidationError as exc:
            # Trace l'extrait brut pour diagnostiquer un schéma mal respecté (typique :
            # `category: null` quand le LLM hésite au lieu de baisser `confidence`).
            logger.warning("réponse non-conforme: raw=%s", raw[:400])
            raise LlmResponseError(f"Décision non conforme au schéma: {exc}") from exc

        return LlmResult(
            decision=decision,
            model=self._model,
            prompt_tokens=usage.get("input_tokens", 0),
            completion_tokens=usage.get("output_tokens", 0),
            raw_response=raw,
        )
