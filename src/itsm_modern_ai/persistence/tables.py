"""Tables SQLModel. Noms `snake_case` pluriel, PK `id`, colonnes `snake_case`.

Note timezone : les colonnes `ts` du Journal et des appels LLM sont **timezone-aware**
(UTC) via `UtcDateTime`. Indispensable pour le portage Postgres futur (audit cybersécu) :
sans ça, comparer `ts < cutoff` casse avec `TypeError: can't compare offset-naive and
offset-aware`. Sur SQLite (TEXT), `UtcDateTime` normalise à la lecture (force aware UTC
même pour les lignes anciennes stockées sans offset).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Column, DateTime, UniqueConstraint
from sqlalchemy.types import TypeDecorator
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator):
    """`DateTime(timezone=True)` qui garantit `tzinfo=UTC` à la lecture.

    Anciennes lignes SQLite stockées en naive (avant ce typage) → réhydratées en aware
    UTC, transparent pour le moteur. Sur Postgres, équivaut à `timestamp with time zone`.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        # À l'écriture : un naive est supposé UTC (cohérent avec `_utcnow`).
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        # À la lecture : si SQLite a relu en naive (anciennes lignes), on force UTC.
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


def _ts_column(*, index: bool = False) -> Column:
    """Colonne `ts` partagée Journal / appels LLM (audit UTC strict)."""
    return Column(UtcDateTime, nullable=False, default=_utcnow, index=index)


class ProcessedTicket(SQLModel, table=True):
    """Idempotence du polling (FR-2).

    Un Ticket déjà traité (présent ici) n'est jamais retraité. La clé est le
    `ticket_id` GLPI ; `state_fingerprint` permet de détecter un changement d'état.
    Posé de façon à survivre à un redémarrage entre l'écriture GLPI et l'enregistrement
    local (au pire on re-vérifie côté GLPI avant d'écrire — cf. Epic 3).
    """

    __tablename__ = "processed_tickets"

    ticket_id: int = Field(primary_key=True)
    state_fingerprint: str = ""
    followup_written: bool = False
    processed_at: datetime = Field(default_factory=_utcnow, sa_column=_ts_column(index=True))


class LlmCall(SQLModel, table=True):
    """Log exhaustif d'un appel LLM (FR-19).

    ⚠️ `prompt_sent` reflète TOUJOURS le Masquage : aucun motif secret en clair
    (invariant PII). Sert aussi au cost cap (FR-10) via `cost_eur`.
    """

    __tablename__ = "llm_calls"

    id: int | None = Field(default=None, primary_key=True)
    ticket_id: int = Field(index=True)
    ts: datetime = Field(default_factory=_utcnow, sa_column=_ts_column(index=True))
    model: str = ""
    prompt_sent: str = ""  # contenu masqué envoyé
    response_received: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_eur: float = 0.0


class DecisionLog(SQLModel, table=True):
    """Journal de décision (FR-20) : table brute, triable, annotable.

    Une ligne par Ticket traité par le moteur (accepté ou « à trier »). La colonne
    `annotation` permet au technicien de qualifier la Décision (protocole SM, §7).
    Aucune métrique nominative n'est produite (anti-mouchard, FR-21).
    """

    __tablename__ = "decisions"

    id: int | None = Field(default=None, primary_key=True)
    ticket_id: int = Field(index=True)
    ts: datetime = Field(default_factory=_utcnow, sa_column=_ts_column(index=True))
    subject: str = ""  # titre du Ticket GLPI (lisible dans le journal)
    accepted: bool = False
    reason: str = ""  # TriageReason
    category: int | None = None
    priority: int | None = None
    technician_id: int | None = None
    group_id: int | None = None
    confidence: float | None = None
    glpi_link: str = ""
    annotation: str = ""  # éditable a posteriori (revue manuelle pilote)
    # Mode d'exécution effectif + a-t-on muté le Ticket GLPI (vs Suivi seul) — traçabilité.
    mode: str = ""  # ExecutionMode résolu pour le périmètre
    applied: bool = False  # True si la Décision a été appliquée aux champs GLPI


class ReferentialCache(SQLModel, table=True):
    """Référentiels GLPI scannés + sélections de l'admin (cœur du périmètre).

    Un enregistrement par objet GLPI (catégorie, entité, technicien, groupe), rafraîchi
    par un scan GLPI. L'admin choisit ensuite, dans la console, le périmètre que l'IA a
    le droit d'utiliser :
    - `selected` : pour les catégories/entités → autorisée / dans le périmètre.
    - `eligible` : pour les techniciens/groupes → l'IA peut router vers eux.
    - `skills`   : prose libre décrivant le technicien/groupe (routage, FR-15).
    """

    __tablename__ = "referential_cache"
    __table_args__ = (UniqueConstraint("kind", "ext_id", name="uq_referential_kind_ext"),)

    id: int | None = Field(default=None, primary_key=True)
    kind: str = Field(index=True)  # "category" | "entity" | "technician" | "group"
    ext_id: int  # id GLPI
    name: str = ""
    profile: str = ""  # profil(s) GLPI (techniciens) — pour tri/filtre UI
    selected: bool = False  # catégories/entités dans le périmètre
    eligible: bool = False  # techniciens/groupes vers qui l'IA peut router
    skills: str = ""  # prose (techniciens/groupes)
    # Mode d'exécution par ENTITÉ (kind="entity") : None = défaut global (runtime_config).
    # `auto_min_confidence` = 2e seuil strict du mode semi_auto (None = défaut global).
    mode: str | None = None  # "suggestion" | "semi_auto" | "full_auto"
    auto_min_confidence: float | None = None
    updated_at: datetime = Field(default_factory=_utcnow)


class RuntimeConfig(SQLModel, table=True):
    """Configuration poussée au runtime via l'API/UI (pas via .env).

    Porte les SECRETS (clé API LLM, tokens GLPI) chiffrés au repos (FR-25) et les
    réglages surchargeables (URLs, modèle, seuils). `is_secret=True` ⇒ `value` est
    un token chiffré opaque ; sinon `value` est en clair.
    """

    __tablename__ = "runtime_config"

    key: str = Field(primary_key=True)
    value: str = ""
    is_secret: bool = False
    updated_at: datetime = Field(default_factory=_utcnow)
