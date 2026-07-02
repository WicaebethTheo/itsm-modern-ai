"""Cost cap LLM (FR-10) — plafond quotidien en fenêtre glissante de 24 h.

Au-delà du plafond, les Tickets passent « à trier » (aucun appel facturant).
Le coût est accumulé depuis la table `llm_calls`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlmodel import Session, func, select

from ..persistence.tables import LlmCall


def spent_last_24h(session: Session, *, now: datetime | None = None) -> float:
    since = (now or datetime.now(UTC)) - timedelta(hours=24)
    total = session.exec(
        select(func.coalesce(func.sum(LlmCall.cost_eur), 0.0)).where(LlmCall.ts >= since)
    ).one()
    return float(total)


def is_over_cap(session: Session, cap_eur: float, *, now: datetime | None = None) -> bool:
    if cap_eur <= 0:
        return False  # 0 ou négatif = pas de plafond
    return spent_last_24h(session, now=now) >= cap_eur


def cost_eur(prompt_tokens: int, completion_tokens: int, price_in: float, price_out: float) -> float:
    """Coût estimé d'un appel à partir des tokens et des tarifs (€/Mtok)."""
    return prompt_tokens / 1_000_000 * price_in + completion_tokens / 1_000_000 * price_out
