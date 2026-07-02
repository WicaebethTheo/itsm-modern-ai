"""Dashboard inversé (FR-23) — métriques opérationnelles d'ÉQUIPE depuis GLPI.

Calcul PUR (sans I/O) sur une liste de `TicketStat`. Anti-mouchard (SM-C2) : jamais
de métrique par technicien. Anti-vanity (SM-C1) : pas de « tickets traités par l'IA ».

⚠️ En mode suggestion, ces métriques mesurent l'activité de l'ÉQUIPE, pas l'effet causal
de l'outil (PRD §7). Le **taux de réaffectation** exige l'historique GLPI (Log) non lu
ici : il est exposé comme « non disponible » (à brancher), conformément au PRD (UX).
"""

from __future__ import annotations

import statistics
from datetime import datetime

from pydantic import BaseModel

from ..domain.models import TicketStat
from .links import ticket_web_link

STATUS_NEW = 1


class Anomaly(BaseModel):
    ticket_id: int
    kind: str  # "new_stale" | "sla_breached"
    detail: str
    glpi_link: str = ""  # lien front GLPI vers le ticket (si l'URL est configurée)


class OperationalMetrics(BaseModel):
    window_days: int
    tickets_in_window: int
    first_response_median_minutes: float | None  # temps de 1ʳᵉ réponse (médian)
    sla_compliance_rate: float | None  # % clos dans le délai SLA (None si aucun SLA)
    sla_evaluated: int  # nb de tickets ayant un SLA TTR évalué
    reassignment_rate: float | None = None  # nécessite l'historique GLPI — non calculé
    reassignment_available: bool = False
    anomalies: list[Anomaly] = []


def compute(
    stats: list[TicketStat],
    *,
    window_days: int,
    now: datetime,
    new_age_hours: int = 24,
    glpi_base_url: str = "",
) -> OperationalMetrics:
    # Temps de 1ʳᵉ réponse : médiane des délais de prise en compte connus (> 0).
    responses = [s.first_response_seconds for s in stats if s.first_response_seconds]
    first_response = round(statistics.median(responses) / 60, 1) if responses else None

    # Respect SLA : parmi les tickets avec une échéance TTR ET résolus, % à l'heure.
    sla_eval = [s for s in stats if s.time_to_resolve is not None and s.solved is not None]
    sla_rate = (
        round(sum(1 for s in sla_eval if s.solved <= s.time_to_resolve) / len(sla_eval), 3)
        if sla_eval
        else None
    )

    # Anomalies : Tickets « New » trop vieux, ou SLA dépassé sans résolution.
    anomalies: list[Anomaly] = []
    for s in stats:
        if s.status == STATUS_NEW and s.created is not None:
            age_h = (now - s.created).total_seconds() / 3600
            if age_h >= new_age_hours:
                anomalies.append(
                    Anomaly(
                        ticket_id=s.id,
                        kind="new_stale",
                        detail=f"« New » depuis {int(age_h)} h",
                        glpi_link=ticket_web_link(glpi_base_url, s.id),
                    )
                )
        if s.time_to_resolve is not None and not s.is_closed and s.time_to_resolve < now:
            anomalies.append(
                Anomaly(
                    ticket_id=s.id,
                    kind="sla_breached",
                    detail="SLA TTR dépassé, non résolu",
                    glpi_link=ticket_web_link(glpi_base_url, s.id),
                )
            )

    return OperationalMetrics(
        window_days=window_days,
        tickets_in_window=len(stats),
        first_response_median_minutes=first_response,
        sla_compliance_rate=sla_rate,
        sla_evaluated=len(sla_eval),
        anomalies=anomalies,
    )
