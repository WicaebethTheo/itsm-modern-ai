"""Exceptions du domaine."""

from __future__ import annotations


class DomainError(Exception):
    """Base des erreurs métier."""


class LlmResponseError(DomainError):
    """Réponse LLM non parsable / non conforme au schéma Décision (FR-6).

    Levée à la frontière adaptateur ; le pipeline la traduit en « à trier »
    après retry (FR-9) — jamais de crash bloquant la file.
    """


class LlmTransportError(DomainError):
    """Échec réseau/transport vers le fournisseur LLM (FR-9)."""
