"""Rate-limiting du login (FR-24 durci) — limiteur en mémoire par clé."""

from __future__ import annotations

import itsm_modern_ai.api.ratelimit as ratelimit
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


# --- Bornage mémoire : purge des entrées mortes + plafond dur -------------------------
# La clé est l'IP cliente (potentiellement `X-Forwarded-For`, donc contrôlée par
# l'attaquant) : sans purge ni plafond, le dict interne grossit sans limite.


def test_dead_entry_is_evicted(monkeypatch):
    """Une entrée sans échec dans la fenêtre ni blocage actif est purgée au balayage."""
    monkeypatch.setattr(ratelimit, "_SWEEP_EVERY", 4)
    clock = FakeClock()
    lim = _limiter(clock, max_attempts=3, window=300, block=300)
    lim.record_failure("ghost")
    clock.advance(301)  # l'échec sort de la fenêtre → entrée morte
    for i in range(4):  # déclenche le balayage amorti
        lim.record_failure(f"live-{i}")
    assert "ghost" not in lim._entries
    assert lim.retry_after("ghost") is None  # sémantique inchangée : repart de zéro


def test_hard_cap_bounds_entry_count(monkeypatch):
    """Sous un flot de clés uniques, le nombre d'entrées reste borné par le plafond."""
    monkeypatch.setattr(ratelimit, "_MAX_ENTRIES", 50)
    monkeypatch.setattr(ratelimit, "_SWEEP_EVERY", 8)
    lim = _limiter(FakeClock(), max_attempts=3)
    for i in range(1000):  # 1000 IP distinctes, un seul échec chacune
        lim.record_failure(f"10.0.0.{i}")
    assert len(lim._entries) <= 50


def test_blocked_key_survives_entry_flood(monkeypatch):
    """RÉGRESSION : saturer la table d'IP bidon ne doit PAS lever un blocage actif."""
    monkeypatch.setattr(ratelimit, "_MAX_ENTRIES", 50)
    monkeypatch.setattr(ratelimit, "_SWEEP_EVERY", 8)
    lim = _limiter(FakeClock(), max_attempts=3, block=300)
    for _ in range(3):
        lim.record_failure("attacker")
    assert lim.retry_after("attacker") == 300  # bloqué
    for i in range(1000):  # tentative de contournement par saturation
        lim.record_failure(f"10.0.0.{i}")
    assert lim.retry_after("attacker") == 300  # toujours bloqué, blocage jamais évincé
    assert len(lim._entries) <= 50


def test_flood_does_not_evict_any_active_block(monkeypatch):
    """Même saturée uniquement de blocages, la table préserve tous les blocages actifs."""
    lim = _limiter(FakeClock(), max_attempts=2, block=300)
    blocked = [f"bad-{i}" for i in range(20)]
    for key in blocked:
        for _ in range(2):
            lim.record_failure(key)
    assert all(lim.retry_after(k) == 300 for k in blocked)
    # On resserre le plafond APRÈS coup : la table est alors pleine de blocages actifs.
    monkeypatch.setattr(ratelimit, "_MAX_ENTRIES", 20)
    monkeypatch.setattr(ratelimit, "_SWEEP_EVERY", 4)
    for i in range(500):  # flot de clés neuves : rien à évincer sans lever un blocage
        lim.record_failure(f"10.0.0.{i}")
    assert all(lim.retry_after(k) == 300 for k in blocked)  # aucun blocage perdu
    assert len(lim._entries) <= 20


def test_eviction_preserves_block_semantics_after_flood(monkeypatch):
    """Après un flot, une clé évincée repart de zéro et peut re-bloquer normalement."""
    monkeypatch.setattr(ratelimit, "_MAX_ENTRIES", 30)
    monkeypatch.setattr(ratelimit, "_SWEEP_EVERY", 8)
    clock = FakeClock()
    lim = _limiter(clock, max_attempts=3, window=3000, block=300)
    lim.record_failure("old")  # 1 seul échec → évincable (aucun blocage actif)
    clock.advance(1)  # les clés du flot seront plus RÉCENTES → « old » évincé en premier
    for i in range(500):
        lim.record_failure(f"10.0.0.{i}")
    assert lim.record_failure("old") is None
    assert lim.record_failure("old") is None
    assert lim.record_failure("old") == 300  # le blocage au seuil fonctionne toujours


def test_real_flood_stays_under_module_cap():
    """Sans monkeypatch : le plafond de module borne réellement la table."""
    lim = _limiter(FakeClock(), max_attempts=3)
    for _ in range(3):
        lim.record_failure("attacker")
    for i in range(ratelimit._MAX_ENTRIES + 2_000):
        lim.record_failure(f"key-{i}")
    assert len(lim._entries) <= ratelimit._MAX_ENTRIES
    assert lim.retry_after("attacker") == 300
