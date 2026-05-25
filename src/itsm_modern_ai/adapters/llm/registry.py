"""Sélection du connecteur LLM par config (FR-11).

Phase 1 : un seul chemin OpenAI-compatible (Mistral/Ollama/OpenRouter/OpenAI), le
changement de fournisseur se fait par config (base_url + model + clé), sans code.
Le chemin Anthropic est Phase 2 (FR-12, hors périmètre).
"""

from __future__ import annotations

from ...ports.llm import LlmPort
from .openai_compatible import OpenAiCompatibleLlm


def build_llm(*, base_url: str, api_key: str, model: str) -> LlmPort:
    return OpenAiCompatibleLlm(base_url=base_url, api_key=api_key, model=model)
