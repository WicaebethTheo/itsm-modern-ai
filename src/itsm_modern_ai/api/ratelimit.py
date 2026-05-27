"""Rate-limiting du login (anti brute-force) — limiteur EN MÉMOIRE par clé (IP).

Adapté au déploiement pilote mono-process (pas de HA, pas de store partagé). Pour
un déploiement multi-instances il faudrait un backend partagé (Redis) ; ce n'est
pas l'objectif ici (cf. Settings.login_*).

Comportement : on compte les échecs par clé dans une fenêtre glissante ; au-delà de
`max_attempts`, la clé est bloquée pendant `block_seconds`. Un succès réinitialise
la clé (`reset`). Thread-safe (verrou) car uvicorn peut servir en threadpool.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass
class _Entry:
    failures: deque[float] = field(default_factory=deque)  # horodatages monotones des échecs
    blocked_until: float = 0.0


class LoginRateLimiter:
    """Limiteur d'échecs de login par clé (IP). `max_attempts <= 0` ⇒ désactivé."""

    def __init__(
        self,
        *,
        max_attempts: int,
        window_seconds: float,
        block_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max = max_attempts
        self._window = float(window_seconds)
        self._block = float(block_seconds)
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, _Entry] = {}

    @property
    def enabled(self) -> bool:
        return self._max > 0

    def retry_after(self, key: str) -> float | None:
        """Secondes restantes avant déblocage si la clé est bloquée, sinon None."""
        if not self.enabled:
            return None
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            remaining = entry.blocked_until - now
            return remaining if remaining > 0 else None

    def record_failure(self, key: str) -> float | None:
        """Enregistre un échec. Renvoie le délai de blocage si le seuil est franchi."""
        if not self.enabled:
            return None
        now = self._clock()
        with self._lock:
            entry = self._entries.setdefault(key, _Entry())
            self._prune(entry.failures, now)
            entry.failures.append(now)
            if len(entry.failures) >= self._max:
                entry.blocked_until = now + self._block
                entry.failures.clear()
                return self._block
            return None

    def reset(self, key: str) -> None:
        """Réinitialise la clé (à appeler sur login réussi)."""
        if not self.enabled:
            return
        with self._lock:
            self._entries.pop(key, None)

    def _prune(self, failures: deque[float], now: float) -> None:
        """Retire les échecs hors fenêtre (la deque est ordonnée par horodatage)."""
        threshold = now - self._window
        while failures and failures[0] < threshold:
            failures.popleft()
