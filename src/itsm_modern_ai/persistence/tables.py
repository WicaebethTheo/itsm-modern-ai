"""Tables SQLModel. Noms `snake_case` pluriel, PK `id`, colonnes `snake_case`."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(UTC)


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
    processed_at: datetime = Field(default_factory=_utcnow)


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
