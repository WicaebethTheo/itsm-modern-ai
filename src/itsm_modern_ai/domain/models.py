"""Modèles du domaine.

Clés JSON en `snake_case` ANGLAIS (convention project-context.md). Le français
est réservé au texte utilisateur (libellés, brouillon de réponse).
"""

from __future__ import annotations

from datetime import datetime
from enum import IntEnum, StrEnum

from pydantic import BaseModel, ConfigDict, Field


class Priority(IntEnum):
    """Encodage GLPI des priorités (addendum §A, stable toutes versions)."""

    VERY_LOW = 1
    LOW = 2
    MEDIUM = 3
    HIGH = 4
    VERY_HIGH = 5
    MAJOR = 6


class Ticket(BaseModel):
    """Snapshot minimal d'un Ticket GLPI tel que vu par le moteur."""

    model_config = ConfigDict(frozen=True)

    id: int
    title: str = ""
    content: str = ""
    status: int = 1  # 1=New
    entity_id: int = 0  # entités_id GLPI — sert au filtrage par périmètre (Story 5.4)
    # Champs servant au pipeline à deux étages (FR-5) : a-t-on déjà une catégorie
    # et un technicien posés par une règle GLPI ?
    category_id: int = 0
    assignee_present: bool = False


class TicketStat(BaseModel):
    """Données d'un Ticket utiles au Dashboard inversé (FR-23), lues depuis GLPI.

    Métriques d'ÉQUIPE uniquement (jamais par technicien — anti-mouchard, SM-C2).
    `first_response_seconds` = `takeintoaccount_delay_stat` GLPI (proxy temps de 1ʳᵉ réponse).
    """

    model_config = ConfigDict(frozen=True)

    id: int
    status: int = 1
    entity_id: int = 0
    created: datetime | None = None
    solved: datetime | None = None
    time_to_resolve: datetime | None = None  # échéance SLA TTR (nullable)
    first_response_seconds: int | None = None

    @property
    def is_closed(self) -> bool:
        return self.status in (5, 6)  # Solved / Closed


class GlpiIdentity(BaseModel):
    """Compte GLPI sous lequel le bot agit — aperçu pour la console (legacy ou V2).

    Best-effort : seul `account` est garanti ; les autres champs dépendent de ce que
    l'API expose. `has_picture` indique qu'une photo de profil est récupérable (V2).
    """

    model_config = ConfigDict(frozen=True)

    account: str  # nom affichable (prénom nom, ou login)
    username: str = ""  # identifiant de connexion GLPI
    profile: str = ""  # profil/rôle actif (Technician, Super-Admin, …)
    email: str = ""
    has_picture: bool = False


class Decision(BaseModel):
    """Sortie structurée du LLM (FR-6).

    Le LLM **propose** ces valeurs ; le code les **valide** ensuite contre la
    Whitelist (FR-7) puis le seuil de confiance (FR-8). Schéma versionné : toute
    évolution = nouveau champ optionnel (jamais de breaking silencieux).
    """

    model_config = ConfigDict(extra="forbid")

    # `None` autorisé : certains LLM (Sonnet 4.6+) expriment leur doute par null ici
    # malgré le prompt. Le garde-fou (whitelist) considère alors la Décision « à trier »
    # via `CATEGORY_NOT_IN_WHITELIST` — comportement homogène avec un ID hors périmètre.
    category: int | None = Field(default=None, description="ID de catégorie GLPI proposé, null si doute.")
    priority: int = Field(description="Priorité GLPI proposée (1-6).")
    technician_id: int | None = Field(
        default=None, description="ID GLPI du technicien (utilisateur) proposé, sinon null."
    )
    group_id: int | None = Field(
        default=None, description="ID GLPI du groupe proposé (fallback si aucun technicien), sinon null."
    )
    draft: str = Field(
        description=(
            "Brouillon de première réponse, en français. En mode suggestion : jamais envoyé "
            "(Suivi privé). En semi/full-auto : posté en Suivi PUBLIC au demandeur (FR-17)."
        )
    )
    confidence: float = Field(
        ge=0.0, le=1.0, description="Confiance auto-déclarée par le LLM (NON calibrée)."
    )


class Referentials(BaseModel):
    """Périmètre fermé sur lequel l'IA a le droit d'agir (Whitelist effective, FR-3/FR-7).

    Construit depuis GLPI (scan) PUIS restreint par les sélections de l'admin dans
    la console : seules les catégories autorisées et les techniciens/groupes éligibles
    y figurent. `entities` documente le périmètre organisationnel sélectionné.
    """

    model_config = ConfigDict(frozen=True)

    categories: dict[int, str] = Field(default_factory=dict)
    technicians: dict[int, str] = Field(default_factory=dict)
    groups: dict[int, str] = Field(default_factory=dict)
    entities: dict[int, str] = Field(default_factory=dict)
    # Profil(s) GLPI par technicien (id → libellés joints) — sert au tri/filtre UI.
    technician_profiles: dict[int, str] = Field(default_factory=dict)
    priorities: dict[int, str] = Field(
        default_factory=lambda: {p.value: p.name for p in Priority}
    )


class TriageReason(StrEnum):
    """Pourquoi une Décision a été acceptée ou renvoyée « à trier »."""

    ACCEPTED = "accepted"
    INVALID_OUTPUT = "invalid_output"  # JSON non parsable / champ manquant (FR-6/FR-9)
    CATEGORY_NOT_IN_WHITELIST = "category_not_in_whitelist"  # FR-7
    PRIORITY_NOT_IN_WHITELIST = "priority_not_in_whitelist"  # FR-7
    TECHNICIAN_NOT_IN_WHITELIST = "technician_not_in_whitelist"  # FR-7
    NO_ELIGIBLE_ASSIGNEE = "no_eligible_assignee"  # ni technicien ni groupe éligible
    LOW_CONFIDENCE = "low_confidence"  # FR-8
    LLM_ERROR = "llm_error"  # erreur réseau/LLM après retry (FR-9)
    COST_CAP_REACHED = "cost_cap_reached"  # FR-10


class TriageOutcome(BaseModel):
    """Résultat du moteur à garde-fous pour un Ticket.

    `accepted=True` → Décision déposable en Suivi (FR-4). Sinon → « à trier »
    (FR-5/7/8/9/10), seule échappatoire du pipeline.
    """

    accepted: bool
    reason: TriageReason
    decision: Decision | None = None

    @property
    def is_a_trier(self) -> bool:
        return not self.accepted
