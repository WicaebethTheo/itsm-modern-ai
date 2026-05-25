"""Dashboard inversé (FR-23) — calcul pur des métriques d'équipe."""

from __future__ import annotations

from datetime import datetime, timedelta

from itsm_modern_ai.domain.models import TicketStat
from itsm_modern_ai.services import dashboard

NOW = datetime(2026, 6, 1, 12, 0, 0)


def test_first_response_median_and_window():
    stats = [
        TicketStat(id=1, first_response_seconds=120, created=NOW),  # 2 min
        TicketStat(id=2, first_response_seconds=240, created=NOW),  # 4 min
        TicketStat(id=3, first_response_seconds=None, created=NOW),  # ignoré
    ]
    m = dashboard.compute(stats, window_days=7, now=NOW)
    assert m.first_response_median_minutes == 3.0  # médiane(2,4)
    assert m.tickets_in_window == 3


def test_sla_compliance():
    stats = [
        # résolu à l'heure
        TicketStat(id=1, status=5, solved=NOW - timedelta(hours=1), time_to_resolve=NOW),
        # résolu en retard
        TicketStat(id=2, status=5, solved=NOW, time_to_resolve=NOW - timedelta(hours=1)),
        # sans SLA → exclu du calcul
        TicketStat(id=3, status=5, solved=NOW),
    ]
    m = dashboard.compute(stats, window_days=7, now=NOW)
    assert m.sla_evaluated == 2
    assert m.sla_compliance_rate == 0.5


def test_anomalies_new_stale_and_sla_breached():
    stats = [
        TicketStat(id=1, status=1, created=NOW - timedelta(hours=30)),  # New vieux
        TicketStat(id=2, status=2, time_to_resolve=NOW - timedelta(hours=2)),  # SLA dépassé non clos
        TicketStat(id=3, status=1, created=NOW - timedelta(hours=2)),  # récent, OK
    ]
    m = dashboard.compute(stats, window_days=7, now=NOW, new_age_hours=24)
    kinds = {(a.ticket_id, a.kind) for a in m.anomalies}
    assert (1, "new_stale") in kinds
    assert (2, "sla_breached") in kinds
    assert not any(a.ticket_id == 3 for a in m.anomalies)


def test_reassignment_marked_unavailable():
    m = dashboard.compute([], window_days=7, now=NOW)
    assert m.reassignment_available is False and m.reassignment_rate is None
    assert m.first_response_median_minutes is None  # aucun ticket
