"""Durable quota and spend state.

The ledger and the guardian are in-memory by design — routing is a hot path.
But a service that restarts (NSSM recycling it, a machine reboot, a crash)
would come back believing every provider is untouched and every dollar
unspent, and immediately over-send to a provider it was halfway through
burning. The first minute after a restart is exactly when the forecast matters
most, so the state is written to disk and read back.

Timestamps are stored as **wall clock**. The ledger runs on a monotonic clock,
which is meaningless across restarts, so state is converted on the way out and
back in. Events are clamped, never trusted blindly: a clock that moved backward
or a file from last week must not make the router think it has a full quota it
does not have, nor an ancient burn it never made.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("jackierouter.persistence")

STATE_VERSION = 1


class StateStore:
    """Reads and writes one JSON file holding ledger + budget state."""

    def __init__(
        self,
        path: str,
        min_save_interval: float = 5.0,
        wall_clock=time.time,
    ):
        self.path = path
        self.min_save_interval = min_save_interval
        self._wall = wall_clock
        # Not 0.0: with a clock that starts near zero (or an injected one) a
        # fresh store would throttle its very first save and persist nothing.
        self._last_saved: Optional[float] = None

    # -- writing -----------------------------------------------------------

    def save(self, ledger=None, budget=None) -> None:
        """Write state atomically — a half-written file must never be loadable."""
        payload: Dict[str, Any] = {
            "version": STATE_VERSION,
            "saved_at": self._wall(),
        }
        # Pass this store's clock down so the internal -> wall conversion uses
        # one consistent notion of "now" on both sides of a save/load.
        if ledger is not None:
            payload["ledger"] = ledger.export_state(wall_clock=self._wall)
        if budget is not None:
            payload["budget"] = budget.export_state(wall_clock=self._wall)

        directory = os.path.dirname(os.path.abspath(self.path)) or "."
        try:
            os.makedirs(directory, exist_ok=True)
            handle = tempfile.NamedTemporaryFile(
                "w", dir=directory, prefix=".jackierouter-", suffix=".tmp",
                delete=False, encoding="utf-8",
            )
            try:
                json.dump(payload, handle)
                handle.flush()
                os.fsync(handle.fileno())
            finally:
                handle.close()
            os.replace(handle.name, self.path)
            self._last_saved = self._wall()
        except OSError as exc:
            # Losing persistence must not lose the request that triggered it.
            logger.warning("could not persist router state to %s: %s", self.path, exc)

    def maybe_save(self, ledger=None, budget=None, force: bool = False) -> bool:
        """Throttled save. ``force`` for writes that must not be lost (spend)."""
        if (
            not force
            and self._last_saved is not None
            and self._wall() - self._last_saved < self.min_save_interval
        ):
            return False
        self.save(ledger=ledger, budget=budget)
        return True

    # -- reading -----------------------------------------------------------

    def load(self, ledger=None, budget=None) -> bool:
        """Restore state. Returns False when there is nothing usable to restore."""
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            return False
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("ignoring unreadable router state at %s: %s", self.path, exc)
            return False

        if not isinstance(payload, dict) or payload.get("version") != STATE_VERSION:
            logger.warning("ignoring router state with unexpected version at %s", self.path)
            return False

        if ledger is not None and isinstance(payload.get("ledger"), dict):
            ledger.import_state(payload["ledger"], wall_clock=self._wall)
        if budget is not None and isinstance(payload.get("budget"), dict):
            budget.import_state(payload["budget"], wall_clock=self._wall)
        return True


def to_wall(at: float, now_internal: float, now_wall: float) -> float:
    """Convert an internal (possibly monotonic) timestamp to wall clock."""
    return now_wall - (now_internal - at)


def from_wall(at_wall: float, now_internal: float, now_wall: float) -> float:
    """Convert a stored wall-clock timestamp back to the internal clock.

    Events from the future (a clock that jumped back) are pinned to now rather
    than trusted — an event that has not happened yet must not excuse burn that
    has.
    """
    age = max(0.0, now_wall - at_wall)
    return now_internal - age
