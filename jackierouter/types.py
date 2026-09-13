"""Core data types shared by the ledger, the guardian, and the router."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence

Message = Dict[str, str]  # {"role": "user", "content": "..."}


def estimate_tokens(text: str) -> int:
    """Cheap, provider-agnostic token estimate.

    Deliberately crude: the ledger corrects itself with real counts as soon as
    a provider reports them. This only has to be good enough to *forecast*.
    """
    if not text:
        return 0
    return max(1, len(text) // 4)


def estimate_message_tokens(messages: Sequence[Message]) -> int:
    return sum(estimate_tokens(m.get("content", "")) for m in messages)


@dataclass(frozen=True)
class Limit:
    """One rate limit window for a provider.

    Either bound may be ``None``, meaning "this window does not cap that".
    """

    window_seconds: float
    requests: Optional[int] = None
    tokens: Optional[int] = None
    label: str = ""

    def name(self) -> str:
        return self.label or f"{int(self.window_seconds)}s"


@dataclass
class Usage:
    """What one call actually consumed."""

    input_tokens: int = 0
    output_tokens: int = 0
    requests: int = 1

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class AdapterResult:
    """What an adapter hands back."""

    text: str
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    raw: Any = None


@dataclass
class Provider:
    """A callable model endpoint plus everything needed to route around it.

    ``tier`` is the cost ladder, not a quality ladder: 0 is hardware you own,
    higher numbers cost more money. The router never climbs a rung while a
    lower one still has headroom.
    """

    name: str
    model: str
    adapter: Any  # anything with .complete(messages, request) -> AdapterResult
    tier: int = 0
    cost_per_1k_input: float = 0.0
    cost_per_1k_output: float = 0.0
    limits: List[Limit] = field(default_factory=list)
    capabilities: frozenset = frozenset()
    max_context: int = 8192
    enabled: bool = True

    @property
    def is_free(self) -> bool:
        return self.cost_per_1k_input == 0.0 and self.cost_per_1k_output == 0.0

    def estimate_cost(self, input_tokens: int, output_tokens: int) -> float:
        return (
            input_tokens / 1000.0 * self.cost_per_1k_input
            + output_tokens / 1000.0 * self.cost_per_1k_output
        )

    def supports(self, capability: Optional[str]) -> bool:
        if not capability or not self.capabilities:
            return True
        return capability in self.capabilities


@dataclass
class RouteRequest:
    """One inbound request to route."""

    messages: List[Message]
    capability: Optional[str] = None
    max_output_tokens: int = 512
    pin: Optional[str] = None  # force a provider by name, skipping selection
    metadata: Dict[str, Any] = field(default_factory=dict)

    def prompt_tokens(self) -> int:
        return estimate_message_tokens(self.messages)

    def last_user_message(self) -> str:
        for message in reversed(self.messages):
            if message.get("role") == "user":
                return message.get("content", "")
        return self.messages[-1].get("content", "") if self.messages else ""


@dataclass
class Attempt:
    """One rung of the dispatch ladder, recorded whether it worked or not."""

    provider: str
    model: str
    tier: int
    outcome: str  # "ok" | "rate_limited" | "error" | "skipped"
    detail: str = ""
    seconds_to_exhaustion: Optional[float] = None
    cost: float = 0.0
    handoff: bool = False


@dataclass
class RoutingResult:
    """A completion plus the full story of how it was obtained."""

    text: str
    provider: str
    model: str
    usage: Usage
    cost: float
    trace: List[Attempt] = field(default_factory=list)
    briefing: Optional[str] = None
    raw: Any = None

    @property
    def handoffs(self) -> int:
        return sum(1 for a in self.trace if a.outcome in ("rate_limited", "error"))
