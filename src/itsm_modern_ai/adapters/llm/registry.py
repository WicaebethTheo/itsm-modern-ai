"""Sélection du connecteur LLM par fournisseur (FR-11/FR-12).

Quatre fournisseurs distincts :
- "mistral"   : Mistral EU (souverain, défaut) — chemin OpenAI-compatible.
- "openai"    : OpenAI (non-souverain) — chemin OpenAI-compatible.
- "ollama"    : modèle LOCAL (pas de clé) — chemin OpenAI-compatible.
- "anthropic" : Claude (non-souverain) — adaptateur dédié.
Le changement se fait par config (UI), sans code.
"""

from __future__ import annotations

from ...ports.llm import LlmPort
from .anthropic import AnthropicLlm
from .openai_compatible import OpenAiCompatibleLlm

PROVIDER_MISTRAL = "mistral"
PROVIDER_OPENAI = "openai"
PROVIDER_OLLAMA = "ollama"
PROVIDER_ANTHROPIC = "anthropic"
PROVIDERS = (PROVIDER_MISTRAL, PROVIDER_OPENAI, PROVIDER_OLLAMA, PROVIDER_ANTHROPIC)


def build_llm(
    *,
    provider: str,
    base_url: str,
    api_key: str,
    model: str,
    anthropic_version: str = "2023-06-01",
    ssrf_guard: bool = False,
) -> LlmPort:
    # Ollama est LOCAL : on tolère localhost/IP privée (sinon le garde anti-SSRF le bloque).
    allow_local = provider == PROVIDER_OLLAMA
    if provider == PROVIDER_ANTHROPIC:
        return AnthropicLlm(
            api_key=api_key,
            model=model,
            base_url=base_url,
            version=anthropic_version,
            ssrf_guard=ssrf_guard,
            allow_local=allow_local,
        )
    # mistral / openai / ollama partagent le chemin OpenAI-compatible.
    return OpenAiCompatibleLlm(
        base_url=base_url,
        api_key=api_key or "local",
        model=model,
        ssrf_guard=ssrf_guard,
        allow_local=allow_local,
    )
