"""Feature Supporter : exports planifiés / DPO+.

Planification d'exports CSV (cron) et calcul de la prochaine échéance. L'export CSV
manuel reste toujours inclus ; cette feature ajoute la planification automatique
et les rapports DPO enrichis.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta


@dataclass(frozen=True)
class ExportSchedule:
    """Planification simple : tous les `every_days` jours à `hour_utc`."""

    every_days: int = 7
    hour_utc: int = 4

    def next_run_after(self, now: datetime) -> datetime:
        base = now.replace(hour=self.hour_utc, minute=0, second=0, microsecond=0)
        if base <= now:
            base = base + timedelta(days=1)
        return base + timedelta(days=max(0, self.every_days - 1))


def register(registry) -> None:
    from itsm_modern_ai.domain.licensing import FEATURE_SCHEDULED_EXPORTS

    registry.register_feature(FEATURE_SCHEDULED_EXPORTS, ExportSchedule())
