"""Rolling spend caps.

The guardian answers "may I spend this?" and remembers what was spent. It does
not decide *whether* paid capacity is warranted — that is the router's tier
ladder, which will not climb to a paid provider while a free one still has
headroom. The guardian is the backstop for when the ladder has no free rung
left: it is what stops a runaway retry loop from becoming a bill.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from .persistence import from_wall, to_wall

# Money in binary floats does not compare cleanly: 0.50 - 0.45 is 0.049999...,
# which would refuse a spend that exactly fits. A sub-micro-cent tolerance is
# far below any real price and removes the whole class of error.
EPSILON = 1e-9


@dataclass(frozen=True)
class SpendWindow:
    seconds: float
    cap: float
    label: str = ""

    def name(self) -> str:
        return self.label or f"{int(self.seconds)}s"


@dataclass
class SpendState:
    window: SpendWindow
    spent: float

    @property
    def remaining(self) -> float:
        return max(0.0, self.window.cap - self.spent)


class BudgetGuardian:
    """Tracks money spent in rolling windows and refuses to break a cap.

    With no windows configured it permits everything, so a local-only
    deployment pays no attention cost for a feature it does not use.
    """

    def __init__(
        self,
        windows: Optional[List[SpendWindow]] = None,
        time_fn: Callable[[], float] = time.monotonic,
    ):
        self.windows = list(windows or [])
        self._time = time_fn
        self._charges: List[tuple] = []  # (at, amount)
        self._lock = threading.Lock()

    @classmethod
    def hourly_daily(cls, per_hour: float, per_day: float, **kwargs) -> "BudgetGuardian":
        return cls(
            [
                SpendWindow(3600.0, per_hour, label="hourly"),
                SpendWindow(86400.0, per_day, label="daily"),
            ],
            **kwargs,
        )

    def _prune(self) -> None:
        with self._lock:
            if not self.windows or not self._charges:
                return
            cutoff = self._time() - max(w.seconds for w in self.windows)
            self._charges = [c for c in self._charges if c[0] >= cutoff]

    def _spent_within(self, seconds: float) -> float:
        cutoff = self._time() - seconds
        with self._lock:
            charges = list(self._charges)
        return sum(amount for at, amount in charges if at >= cutoff)

    def state(self) -> List[SpendState]:
        self._prune()
        return [SpendState(window=w, spent=self._spent_within(w.seconds)) for w in self.windows]

    def can_spend(self, amount: float) -> bool:
        if amount <= 0:
            return True
        return all(state.remaining + EPSILON >= amount for state in self.state())

    def blocking_window(self, amount: float) -> Optional[str]:
        """Name of the first window that would be broken, if any."""
        for state in self.state():
            if state.remaining + EPSILON < amount:
                return state.window.name()
        return None

    def record(self, amount: float) -> None:
        if amount <= 0:
            return
        with self._lock:
            self._charges.append((self._time(), amount))

    def export_state(self, wall_clock: Callable[[], float] = time.time) -> Dict[str, Any]:
        now_internal, now_wall = self._time(), wall_clock()
        with self._lock:
            charges = list(self._charges)
        return {
            "charges": [
                {"at": to_wall(at, now_internal, now_wall), "amount": amount}
                for at, amount in charges
            ]
        }

    def import_state(
        self,
        state: Dict[str, Any],
        wall_clock: Callable[[], float] = time.time,
        max_age_seconds: float = 86400.0,
    ) -> None:
        """Restore spend. Dropping a charge means under-counting, so keep them
        all within the widest window rather than pruning aggressively."""
        now_internal, now_wall = self._time(), wall_clock()
        restored = []
        for charge in state.get("charges") or []:
            try:
                at_wall = float(charge["at"])
                amount = float(charge["amount"])
            except (KeyError, TypeError, ValueError):
                continue
            if now_wall - at_wall > max_age_seconds:
                continue
            restored.append((from_wall(at_wall, now_internal, now_wall), amount))

        if not restored:
            return
        with self._lock:
            self._charges = sorted(self._charges + restored, key=lambda c: c[0])

    def snapshot(self) -> Dict[str, Dict[str, float]]:
        return {
            state.window.name(): {
                "cap": state.window.cap,
                "spent": round(state.spent, 6),
                "remaining": round(state.remaining, 6),
            }
            for state in self.state()
        }
