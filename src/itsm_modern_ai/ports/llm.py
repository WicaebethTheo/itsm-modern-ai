"""Port LLM — interface provider-agnostique (FR-11).

Le moteur appelle `complete()` ; un adaptateur OpenAI-compatible l'implémente
(défaut Mistral EU). Le JSON mode garantit la forme, la Whitelist garantit le
contenu. Portable Ollama/OpenRouter/OpenAI sans tool-calling spécifique.
"""

from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel

from ..domain.models import Decision


class LlmResult(BaseModel):
    """Décision parsée + métadonnées d'appel (pour log FR-19 et coût FR-10)."""

    decision: Decision
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    raw_response: str = ""


class LlmPort(Protocol):
    """Contrat d'inférence. Lève `LlmResponseError`/`LlmTransportError` (domain.errors)."""

    async def complete(self, system_prompt: str, user_prompt: str) -> LlmResult:
        """Appelle le LLM en JSON mode et renvoie une `Decision` validée Pydantic."""
        ...
