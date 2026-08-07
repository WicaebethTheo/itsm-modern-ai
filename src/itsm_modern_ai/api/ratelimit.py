"""Rate-limiting du login (anti brute-force) — limiteur EN MÉMOIRE par clé (IP).

Adapté au déploiement pilote mono-process (pas de HA, pas de store partagé). Pour
un déploiement multi-instances il faudrait un backend partagé (Redis) ; ce n'est
pas l'objectif ici (cf. Settings.login_*).

Comportement : on compte les échecs par clé dans une fenêtre glissante ; au-delà de
`max_attempts`, la clé est bloquée pendant `block_seconds`. Un succès réinitialise
la clé (`reset`). Thread-safe (verrou) car uvicorn peut servir en threadpool.

⚠️ La table des clés est BORNÉE (cf. `_MAX_ENTRIES`) : la clé est l'IP cliente, donc
une valeur potentiellement contrôlée par l'attaquant quand `trust_proxy_headers` est
actif (`X-Forwarded-For`). Sans borne ni purge, chaque valeur distincte laisserait une
entrée à vie et ferait croître la mémoire du process sans limite.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

# Plafond DUR du nombre de clés suivies simultanément. Une entrée ≈ une petite deque
# d'au plus `max_attempts` flottants : 10 000 entrées restent de l'ordre de quelques
# Mo, très au-dessus du nombre d'IP légitimes d'un pilote mono-instance, tout en
# garantissant une empreinte mémoire bornée sous flot d'IP uniques.
_MAX_ENTRIES = 10_000

# Amortissement du balayage : un balayage complet est en O(n). Le faire à CHAQUE échec
# rendrait chaque appel O(n) (donc coûteux à la première tentative de login d'une
# journée chargée). On ne balaie qu'une écriture sur `_SWEEP_EVERY` — ou immédiatement
# si le plafond est atteint et qu'il faut faire de la place. Coût amorti par appel :
# O(n / _SWEEP_EVERY), avec n borné par `_MAX_ENTRIES`.
_SWEEP_EVERY = 128


@dataclass
class _Entry:
    failures: deque[float] = field(default_factory=deque)  # horodatages monotones des échecs
    blocked_until: float = 0.0
    last_seen: float = 0.0  # dernier échec enregistré (récence, pour l'éviction)


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
        self._ops = 0  # compteur d'écritures depuis le dernier balayage (amortissement)
        self._saturated = False  # dernier balayage n'a rien libéré (table pleine de blocages)

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
        """Enregistre un échec. Renvoie le délai de blocage si le seuil est franchi.

        Effet de bord : déclenche périodiquement le balayage/éviction (cf. `_sweep`)
        pour garder la table bornée. Dans le cas extrême où le plafond est atteint et
        où plus rien n'est évincable, la clé n'est pas suivie (renvoie None) — cf. le
        compromis documenté dans `_sweep`.
        """
        if not self.enabled:
            return None
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            # Balayage amorti, ou immédiat s'il faut faire de la place pour une clé neuve.
            # `_saturated` évite de re-balayer en O(n) à CHAQUE clé neuve quand le dernier
            # balayage n'a rien pu libérer (table pleine de blocages actifs) : ce serait
            # une amplification DoS. On repasse alors par le balayage amorti.
            self._ops += 1
            need_room = entry is None and len(self._entries) >= _MAX_ENTRIES
            if self._ops >= _SWEEP_EVERY or (need_room and not self._saturated):
                self._ops = 0
                freed = self._sweep(now)
                self._saturated = need_room and freed == 0
                entry = self._entries.get(key)  # le balayage a pu retirer une entrée morte
            if entry is None:
                if len(self._entries) >= _MAX_ENTRIES:
                    return None  # plafond saturé de blocages actifs : on ne suit pas cette clé
                entry = self._entries[key] = _Entry()
            self._prune(entry.failures, now)
            entry.failures.append(now)
            entry.last_seen = now
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

    def _sweep(self, now: float) -> int:
        """Purge les entrées MORTES puis, si le plafond tient toujours, évince les plus
        anciennes — mais JAMAIS une entrée actuellement BLOQUÉE. Renvoie le nombre
        d'entrées libérées.

        Une entrée est morte quand elle n'a plus aucun échec dans la fenêtre glissante
        ET qu'aucun blocage n'est actif : la retirer est strictement équivalent à la
        garder (une clé absente repart de zéro), donc la sémantique observable du
        limiteur est inchangée.

        Éviction (uniquement si la purge n'a pas suffi) : par récence croissante
        (`last_seen`), en SAUTANT les blocages actifs. On descend jusqu'à un seuil bas
        (90 % du plafond) pour ne pas re-balayer à chaque nouvelle clé sous flot d'IP.

        ⚠️ Compromis assumé : si le plafond est atteint alors que toutes les entrées
        restantes sont des blocages ACTIFS, on refuse de suivre les clés neuves plutôt
        que de lever un blocage. Évincer un blocage offrirait un contournement trivial
        (saturer la table avec des IP bidon pour se débloquer) ; ne pas suivre une clé
        neuve ne coûte qu'un retard de détection, et saturer le plafond de blocages
        ACTIFS exige `_MAX_ENTRIES × max_attempts` échecs RÉELS (≈ 30 000 requêtes) dont
        les blocages expirent d'eux-mêmes après `block_seconds`.
        """
        before = len(self._entries)
        for key, entry in list(self._entries.items()):
            self._prune(entry.failures, now)
            if not entry.failures and entry.blocked_until <= now:
                del self._entries[key]
        if len(self._entries) >= _MAX_ENTRIES:
            low_water = max(1, (_MAX_ENTRIES * 9) // 10)
            evictable = sorted((e.last_seen, k) for k, e in self._entries.items() if e.blocked_until <= now)
            for _, key in evictable:
                if len(self._entries) <= low_water:
                    break
                del self._entries[key]
        return before - len(self._entries)
