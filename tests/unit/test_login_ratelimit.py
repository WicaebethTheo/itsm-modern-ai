"""Rate-limiting du login (FR-24 durci) — limiteur en mémoire par clé."""

from __future__ import annotations

from itsm_modern_ai.api.ratelimit import LoginRateLimiter


class FakeClock:
    """Horloge contrôlable pour tester fenêtre et expiration sans dormir."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def _limiter(clock, *, max_attempts=3, window=300, block=300):
    return LoginRateLimiter(
        max_attempts=max_attempts,
        window_seconds=window,
        block_seconds=block,
        clock=clock,
    )


def test_disabled_when_max_attempts_zero():
    lim = _limiter(FakeClock(), max_attempts=0)
    assert lim.enabled is False
    for _ in range(10):
        assert lim.record_failure("ip") is None
    assert lim.retry_after("ip") is None


def test_blocks_after_max_failures():
    clock = FakeClock()
    lim = _limiter(clock, max_attempts=3)
    assert lim.retry_after("ip") is None  # vierge
    assert lim.record_failure("ip") is None  # 1
    assert lim.record_failure("ip") is None  # 2
    assert lim.record_failure("ip") == 300  # 3e échec → blocage déclenché
    ra = lim.retry_after("ip")
    assert ra is not None and 0 < ra <= 300


def test_other_key_unaffected():
    lim = _limiter(FakeClock(), max_attempts=3)
    for _ in range(3):
        lim.record_failure("attacker")
    assert lim.retry_after("attacker") is not None
    assert lim.retry_after("legit") is None  # une autre IP n'est pas bloquée


def test_failures_outside_window_are_pruned():
    clock = FakeClock()
    lim = _limiter(clock, max_attempts=3, window=300)
    lim.record_failure("ip")
    lim.record_failure("ip")
    clock.advance(301)  # les 2 premiers sortent de la fenêtre
    assert lim.record_failure("ip") is None  # ne compte que celui-ci → pas de blocage
    assert lim.retry_after("ip") is None


def test_block_expires_after_block_seconds():
    clock = FakeClock()
    lim = _limiter(clock, max_attempts=3, block=300)
    for _ in range(3):
        lim.record_failure("ip")
    assert lim.retry_after("ip") is not None
    clock.advance(301)
    assert lim.retry_after("ip") is None  # blocage levé


def test_reset_clears_failures():
    lim = _limiter(FakeClock(), max_attempts=3)
    lim.record_failure("ip")
    lim.record_failure("ip")
    lim.reset("ip")  # login réussi
    assert lim.record_failure("ip") is None  # repart de zéro
    assert lim.retry_after("ip") is None
