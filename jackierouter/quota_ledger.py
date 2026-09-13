"""Usage accounting with rate-based exhaustion forecasting.

The point of this module is to answer one question earlier than a 429 can:
*at the rate we are currently burning this provider, how long until it is
spent?* A router that only reacts to 429s has already failed the request that
hit the wall. A router that reacts to a forecast moves while there is still
headroom, and the user never sees the wall at all.

The forecast is deliberately conservative. It measures burn over the observed
span inside each window and ignores the fact that old events will age out of
the sliding window, which makes it warn slightly early rather than slightly
late. Early is the useful direction to be wrong in.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from .types import Limit, Provider, Usage

INFINITE = math.inf


@dataclass
class _Event:
    at: float
    requests: int
    tokens: int


@dataclass
class WindowState:
    """How one limit window currently stands."""

    limit: Limit
    used_requests: int
    used_tokens: int
    remaining_requests: Optional[int]
    remaining_tokens: Optional[int]
    fraction_remaining: float
    seconds_to_exhaustion: float

    @property
    def exhausted(self) -> bool:
        return self.fraction_remaining <= 0.0


@dataclass
class Forecast:
    """The worst case across every window a provider declares."""

    provider: str
    seconds_to_exhaustion: float
    fraction_remaining: float
    limiting_window: Optional[str] = None
    windows: List[WindowState] = field(default_factory=list)

    @property
    def exhausted(self) -> bool:
        return self.fraction_remaining <= 0.0

    def at_risk(self, horizon_seconds: float) -> bool:
        """True when this provider is likely to run dry within the horizon."""
        return self.exhausted or self.seconds_to_exhaustion <= horizon_seconds

    def describe(self) -> str:
        if self.seconds_to_exhaustion == INFINITE:
            return f"{self.provider}: unmetered"
        return (
            f"{self.provider}: {self.fraction_remaining:.0%} left, "
            f"~{self.seconds_to_exhaustion:.0f}s to exhaustion"
            + (f" ({self.limiting_window})" if self.limiting_window else "")
        )


class QuotaLedger:
    """Sliding-window usage records, one series per provider.

    ``time_fn`` is injectable so the forecasting logic is testable without
    sleeping. Everything is in-process and in-memory by design: this is a hot
    path, and a router that needs a database to decide where to send a request
    is not a router anyone will install.
    """

    def __init__(self, time_fn: Callable[[], float] = time.monotonic):
        self._time = time_fn
        self._events: Dict[str, List[_Event]] = {}
        # A gateway serves requests from a thread pool; _prune reassigns the
        # event list, so an unguarded concurrent append would vanish.
        self._lock = threading.Lock()

    # -- recording ---------------------------------------------------------

    def record(self, provider: str, usage: Usage) -> None:
        with self._lock:
            events = self._events.setdefault(provider, [])
            events.append(
                _Event(at=self._time(), requests=usage.requests, tokens=usage.total_tokens)
            )

    def record_rejection(self, provider: str) -> None:
        """A refused call still consumed a request slot on most providers."""
        self.record(provider, Usage(requests=1))

    def reset(self, provider: Optional[str] = None) -> None:
        with self._lock:
            if provider is None:
                self._events.clear()
            else:
                self._events.pop(provider, None)

    # -- reading -----------------------------------------------------------

    def _prune(self, provider: str, oldest_window: float) -> List[_Event]:
        with self._lock:
            events = self._events.get(provider, [])
            if not events:
                return []
            cutoff = self._time() - oldest_window
            kept = [e for e in events if e.at >= cutoff]
            self._events[provider] = kept
            return list(kept)

    def _window_state(self, events: List[_Event], limit: Limit, now: float) -> WindowState:
        cutoff = now - limit.window_seconds
        in_window = [e for e in events if e.at >= cutoff]
        used_requests = sum(e.requests for e in in_window)
        used_tokens = sum(e.tokens for e in in_window)

        # Burn rate is measured over the span actually observed inside the
        # window, floored at one second so a single fast burst cannot produce
        # an absurd per-second rate.
        span = max(now - min((e.at for e in in_window), default=now), 1.0)

        fractions: List[float] = []
        times: List[float] = []

        remaining_requests = None
        if limit.requests is not None:
            remaining_requests = max(0, limit.requests - used_requests)
            fractions.append(remaining_requests / limit.requests if limit.requests else 1.0)
            rate = used_requests / span
            times.append(remaining_requests / rate if rate > 0 else INFINITE)

        remaining_tokens = None
        if limit.tokens is not None:
            remaining_tokens = max(0, limit.tokens - used_tokens)
            fractions.append(remaining_tokens / limit.tokens if limit.tokens else 1.0)
            rate = used_tokens / span
            times.append(remaining_tokens / rate if rate > 0 else INFINITE)

        return WindowState(
            limit=limit,
            used_requests=used_requests,
            used_tokens=used_tokens,
            remaining_requests=remaining_requests,
            remaining_tokens=remaining_tokens,
            fraction_remaining=min(fractions) if fractions else 1.0,
            seconds_to_exhaustion=min(times) if times else INFINITE,
        )

    def forecast(self, provider: Provider) -> Forecast:
        """Predict when ``provider`` runs dry at its current burn rate."""
        if not provider.limits:
            return Forecast(
                provider=provider.name,
                seconds_to_exhaustion=INFINITE,
                fraction_remaining=1.0,
            )

        oldest = max(limit.window_seconds for limit in provider.limits)
        events = self._prune(provider.name, oldest)
        now = self._time()

        windows = [self._window_state(events, limit, now) for limit in provider.limits]
        worst = min(windows, key=lambda w: (w.fraction_remaining, w.seconds_to_exhaustion))

        return Forecast(
            provider=provider.name,
            seconds_to_exhaustion=min(w.seconds_to_exhaustion for w in windows),
            fraction_remaining=worst.fraction_remaining,
            limiting_window=worst.limit.name(),
            windows=windows,
        )

    def would_exceed(self, provider: Provider, tokens: int, requests: int = 1) -> bool:
        """True when a call of this size cannot fit inside a declared window."""
        forecast = self.forecast(provider)
        for window in forecast.windows:
            if window.remaining_requests is not None and requests > window.remaining_requests:
                return True
            if window.remaining_tokens is not None and tokens > window.remaining_tokens:
                return True
        return False
