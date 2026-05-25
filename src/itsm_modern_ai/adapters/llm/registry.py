"""Sélection du connecteur LLM par config (FR-11/FR-12).

Deux chemins : OpenAI-compatible (Mistral/Ollama/OpenRouter/OpenAI, défaut souverain
Mistral EU) et Anthropic (Phase 2). Le changement se fait par config, sans code.
"""

from __future__ import annotations

from ...ports.llm import LlmPort
from .anthropic import AnthropicLlm
from .openai_compatible import OpenAiCompatibleLlm

PROVIDER_OPENAI = "openai_compatible"
PROVIDER_ANTHROPIC = "anthropic"
PROVIDERS = (PROVIDER_OPENAI, PROVIDER_ANTHROPIC)


def build_llm(
    *,
    provider: str,
    base_url: str,
    api_key: str,
    model: str,
    anthropic_version: str = "2023-06-01",
) -> LlmPort:
    if provider == PROVIDER_ANTHROPIC:
        return AnthropicLlm(api_key=api_key, model=model, base_url=base_url, version=anthropic_version)
    return OpenAiCompatibleLlm(base_url=base_url, api_key=api_key, model=model)
