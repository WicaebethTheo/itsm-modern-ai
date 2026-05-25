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


class ItsmError(DomainError):
    """Erreur de l'ITSM (GLPI) : réponse inattendue, opération refusée."""


class ItsmUnavailableError(ItsmError):
    """GLPI injoignable / mal configuré (FR-1).

    Levée explicitement (pas de démarrage silencieux dégradé). Le polling
    reprend au cycle suivant sans perte de Ticket (FR-2, NFR3).
    """


class ItsmAuthError(ItsmError):
    """Échec d'authentification GLPI (initSession)."""
