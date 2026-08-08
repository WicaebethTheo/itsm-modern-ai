"""Modèles du domaine.

Clés JSON en `snake_case` ANGLAIS (convention project-context.md). Le français
est réservé au texte utilisateur (libellés, brouillon de réponse).
"""

from __future__ import annotations

from datetime import datetime
from enum import IntEnum, StrEnum

from pydantic import BaseModel, ConfigDict, Field

# Nombre moyen de caractères par token, servant d'ESTIMATION quand le fournisseur ne
# renvoie pas de bloc `usage` (passerelle minimaliste) ou quand l'appel a échoué avant
# toute comptabilisation. Ordre de grandeur pour du français en tokenizer BPE ; c'est
# volontairement une approximation ASSUMÉE : mieux vaut un coût approché qui fait
# avancer le plafond (FR-10) qu'un 0,00 € silencieux qui le rend aveugle.
# Vit dans le domaine (et non dans un adaptateur) car adaptateurs LLM ET moteur de
# triage partagent la même unité de mesure — le domaine ne dépend de personne.
TOKEN_CHARS_RATIO = 3.6


def estimate_tokens(text: str) -> int:
    """Estimation grossière du nombre de tokens d'un texte (jamais 0 pour un texte non vide).

    Utilisée UNIQUEMENT en repli : `usage` absent côté fournisseur, ou appel facturé
    dont on ne connaîtra jamais la comptabilité exacte (échec après émission). Le
    plancher à 1 évite qu'un texte court soit compté gratuit.
    """
    if not text:
        return 0
    return max(1, int(len(text) / TOKEN_CHARS_RATIO))


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

    # `strict=True` en plus de `extra="forbid"` (durcissement audit 2026-08) : sans lui,
    # Pydantic COERCE silencieusement la sortie du LLM et la frontière n'en est plus une.
    # Vérifié : `{"category": true}` donnait `category=1` → une Décision était ACCEPTÉE
    # sur la catégorie #1 alors que le modèle n'avait proposé aucune catégorie ; `"3"`
    # donnait `3`. Un type faux est le SYMPTÔME d'une sortie non maîtrisée : il doit
    # partir en `invalid_output` (seule échappatoire), pas être rattrapé en douce.
    # NB : Pydantic strict tolère un `int` pour un champ `float` (`confidence: 1` reste
    # valide) — c'est la seule coercition conservée, et elle est sans ambiguïté.
    # Les fournisseurs qui sérialisent leurs nombres en chaîne (`"3"`) sont pris en
    # charge par une coercition EXPLICITE et bornée dans l'adaptateur
    # (`adapters/llm/_decision.py`), jamais implicitement ici.
    model_config = ConfigDict(extra="forbid", strict=True)

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


class HandlerOutcome(BaseModel):
    """Ce que le handler de triage rapporte au poller — contrat élargi (audit 2026-08).

    Le handler ne renvoyait qu'un `bool` (« un Suivi a-t-il été écrit ? »). Le poller ne
    pouvait donc PAS distinguer « le Ticket a été arbitré » de « le triage N'A PAS EU
    LIEU » (plafond atteint, panne LLM, sortie invalide) : dans les deux cas il posait le
    marqueur « traité » et le Ticket était brûlé DÉFINITIVEMENT, sans reprise ni écran
    pour le rejouer. Quatre informations suffisent à refermer ça :

    - `followup_written` : équivalent de l'ancien `bool` (Suivi réellement déposé) ;
    - `retryable` : le triage n'a pas abouti → NE PAS consommer le Ticket ;
    - `costly` : la tentative a (ou a pu) coûter des tokens → elle consomme un essai du
      compteur borné du poller, garde-fou contre un Ticket éternellement invalide ;
    - `db_error` : une écriture en base a échoué → alimente le circuit-breaker du poller
      (une base en panne ne doit pas produire une boucle d'appels LLM facturés).
    """

    model_config = ConfigDict(frozen=True)

    followup_written: bool = False
    retryable: bool = False
    costly: bool = False
    db_error: bool = False
    reason: TriageReason | None = None
