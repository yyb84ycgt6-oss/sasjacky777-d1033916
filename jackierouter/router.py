"""Predictive, cost-tiered routing with context-preserving failover.

Three rules, in order:

1. **Move before the wall.** Providers are ranked by forecast health, not just
   by whether their last call succeeded. A provider the ledger expects to run
   dry inside the horizon loses to a healthy one, so the migration happens
   while there is still headroom.
2. **Climb the cost ladder only when you must.** Tier 0 is hardware you own.
   The router does not reach for a paid provider while a free one is healthy,
   and the budget guardian is the hard stop behind that.
3. **Carry the thread across.** Every failover attaches a briefing built from
   the interrupted turn, so the next model continues mid-thought instead of
   starting cold.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from .budget_guardian import BudgetGuardian
from .errors import BudgetExceeded, NoProviderAvailable, ProviderError, RateLimited
from .handoff import HandoffBriefing, apply_briefing, build_briefing
from .quota_ledger import Forecast, QuotaLedger
from .types import Attempt, Provider, RouteRequest, RoutingResult, Usage

logger = logging.getLogger("jackierouter")

MIGRATE = "migrate"   # healthy providers first, whatever their tier
CONSERVE = "conserve"  # cheapest tier first, even when it is nearly spent


@dataclass
class Candidate:
    provider: Provider
    forecast: Forecast
    healthy: bool


class Router:
    """Selects a provider per request and fails over without losing context."""

    def __init__(
        self,
        providers: Sequence[Provider],
        *,
        ledger: Optional[QuotaLedger] = None,
        budget: Optional[BudgetGuardian] = None,
        horizon_seconds: float = 30.0,
        risk_policy: str = MIGRATE,
        briefing_max_chars: int = 2000,
        max_attempts: int = 4,
        time_fn: Callable[[], float] = time.monotonic,
    ):
        if risk_policy not in (MIGRATE, CONSERVE):
            raise ValueError(f"unknown risk_policy: {risk_policy!r}")
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self.providers = list(providers)
        self._time = time_fn
        self.ledger = ledger or QuotaLedger(time_fn=time_fn)
        self.budget = budget or BudgetGuardian(time_fn=time_fn)
        self.horizon_seconds = horizon_seconds
        self.risk_policy = risk_policy
        self.briefing_max_chars = briefing_max_chars
        self.max_attempts = max_attempts
        self._cooldowns: Dict[str, float] = {}

    # -- selection ---------------------------------------------------------

    def _in_cooldown(self, provider: Provider) -> bool:
        until = self._cooldowns.get(provider.name)
        return until is not None and until > self._time()

    def plan(self, request: RouteRequest) -> Tuple[List[Candidate], List[Attempt]]:
        """Order the providers worth trying, and record why the rest were not."""
        candidates: List[Candidate] = []
        skipped: List[Attempt] = []
        needed_tokens = request.prompt_tokens() + request.max_output_tokens

        for provider in self.providers:
            def skip(reason: str) -> None:
                skipped.append(
                    Attempt(
                        provider=provider.name,
                        model=provider.model,
                        tier=provider.tier,
                        outcome="skipped",
                        detail=reason,
                    )
                )

            if not provider.enabled:
                skip("disabled")
                continue
            if request.pin and provider.name != request.pin:
                continue
            if not provider.supports(request.capability):
                skip(f"lacks capability {request.capability!r}")
                continue
            if needed_tokens > provider.max_context:
                skip(f"context {needed_tokens} > {provider.max_context}")
                continue
            if self._in_cooldown(provider):
                remaining = self._cooldowns[provider.name] - self._time()
                skip(f"cooling down for {remaining:.0f}s")
                continue

            forecast = self.ledger.forecast(provider)
            if self.ledger.would_exceed(provider, needed_tokens):
                skip(f"call does not fit remaining quota ({forecast.describe()})")
                continue

            cost = provider.estimate_cost(request.prompt_tokens(), request.max_output_tokens)
            if cost > 0 and not self.budget.can_spend(cost):
                skip(f"budget cap reached ({self.budget.blocking_window(cost)})")
                continue

            candidates.append(
                Candidate(
                    provider=provider,
                    forecast=forecast,
                    healthy=not forecast.at_risk(self.horizon_seconds),
                )
            )

        if request.pin:
            if not candidates and not any(a.provider == request.pin for a in skipped):
                skipped.append(
                    Attempt(
                        provider=request.pin,
                        model="",
                        tier=0,
                        outcome="skipped",
                        detail="pinned provider is not configured",
                    )
                )
            return candidates, skipped
        return self._order(candidates), skipped

    def _order(self, candidates: List[Candidate]) -> List[Candidate]:
        def by_cost(candidate: Candidate):
            return (candidate.provider.tier, -candidate.forecast.fraction_remaining)

        if self.risk_policy == CONSERVE:
            # Cheapest rung first; health only breaks ties inside a tier.
            return sorted(
                candidates,
                key=lambda c: (c.provider.tier, c.healthy is False, -c.forecast.fraction_remaining),
            )

        # MIGRATE: anything with headroom beats anything about to run dry,
        # and within each group the cheapest wins.
        healthy = sorted([c for c in candidates if c.healthy], key=by_cost)
        at_risk = sorted(
            [c for c in candidates if not c.healthy and not c.forecast.exhausted], key=by_cost
        )
        spent = sorted([c for c in candidates if c.forecast.exhausted], key=by_cost)
        return healthy + at_risk + spent

    # -- dispatch ----------------------------------------------------------

    def dispatch(self, request: RouteRequest) -> RoutingResult:
        """Run the request, failing over down the ladder until one provider answers."""
        candidates, trace = self.plan(request)
        if not candidates:
            if trace and all(
                a.outcome == "skipped" and "budget cap" in a.detail for a in trace
            ):
                raise BudgetExceeded("every remaining provider is over budget", trace=trace)
            raise NoProviderAvailable("no provider passed selection", trace=trace)

        briefing: Optional[HandoffBriefing] = None
        partial_output = ""

        for candidate in candidates[: self.max_attempts]:
            provider = candidate.provider
            messages = apply_briefing(request.messages, briefing)

            # Re-check the cap here, not just at plan time: a briefing grows
            # the prompt, and earlier failures may have spent the budget.
            cost_estimate = provider.estimate_cost(
                request.prompt_tokens() + (briefing.estimated_tokens() if briefing else 0),
                request.max_output_tokens,
            )
            if cost_estimate > 0 and not self.budget.can_spend(cost_estimate):
                trace.append(
                    self._attempt(
                        candidate,
                        "skipped",
                        f"budget cap reached ({self.budget.blocking_window(cost_estimate)})",
                    )
                )
                continue

            try:
                result = provider.adapter.complete(messages, request)
            except RateLimited as exc:
                partial_output = getattr(exc, "partial_output", "") or partial_output
                briefing = self._handoff(request, provider, f"rate limited: {exc}", partial_output)
                self._penalize(provider, exc)
                trace.append(
                    self._attempt(candidate, "rate_limited", str(exc), handoff=True)
                )
                continue
            except ProviderError as exc:
                partial_output = getattr(exc, "partial_output", "") or partial_output
                briefing = self._handoff(request, provider, f"provider error: {exc}", partial_output)
                self._penalize(provider, exc)
                trace.append(self._attempt(candidate, "error", str(exc), handoff=True))
                continue
            except Exception as exc:  # an adapter's own bug must not end the ladder
                wrapped = ProviderError(str(exc), provider=provider.name)
                briefing = self._handoff(request, provider, f"adapter raised {exc!r}", partial_output)
                self._penalize(provider, wrapped)
                trace.append(self._attempt(candidate, "error", repr(exc), handoff=True))
                continue

            usage = Usage(
                input_tokens=(
                    result.input_tokens
                    if result.input_tokens is not None
                    else request.prompt_tokens() + (briefing.estimated_tokens() if briefing else 0)
                ),
                output_tokens=(
                    result.output_tokens
                    if result.output_tokens is not None
                    else len(result.text) // 4
                ),
            )
            cost = provider.estimate_cost(usage.input_tokens, usage.output_tokens)

            self.ledger.record(provider.name, usage)
            self.budget.record(cost)
            self._cooldowns.pop(provider.name, None)
            trace.append(self._attempt(candidate, "ok", "", cost=cost, handoff=briefing is not None))

            return RoutingResult(
                text=result.text,
                provider=provider.name,
                model=provider.model,
                usage=usage,
                cost=cost,
                trace=trace,
                briefing=briefing.render() if briefing else None,
                raw=result.raw,
            )

        raise NoProviderAvailable("every candidate failed", trace=trace)

    def _attempt(
        self,
        candidate: Candidate,
        outcome: str,
        detail: str,
        *,
        cost: float = 0.0,
        handoff: bool = False,
    ) -> Attempt:
        seconds = candidate.forecast.seconds_to_exhaustion
        return Attempt(
            provider=candidate.provider.name,
            model=candidate.provider.model,
            tier=candidate.provider.tier,
            outcome=outcome,
            detail=detail,
            seconds_to_exhaustion=None if seconds == float("inf") else round(seconds, 1),
            cost=cost,
            handoff=handoff,
        )

    def _handoff(
        self,
        request: RouteRequest,
        provider: Provider,
        reason: str,
        partial_output: str,
    ) -> HandoffBriefing:
        logger.info("handing off from %s: %s", provider.name, reason)
        return build_briefing(
            request,
            prior_provider=provider.name,
            reason=reason,
            partial_output=partial_output,
            max_chars=self.briefing_max_chars,
        )

    def _penalize(self, provider: Provider, exc: ProviderError) -> None:
        self.ledger.record_rejection(provider.name)
        self._cooldowns[provider.name] = self._time() + max(0.0, exc.retry_after)

    # -- introspection -----------------------------------------------------

    def status(self) -> Dict:
        """Everything an operator wants on a dashboard, in one call."""
        now = self._time()
        return {
            "horizon_seconds": self.horizon_seconds,
            "risk_policy": self.risk_policy,
            "budget": self.budget.snapshot(),
            "providers": [
                {
                    "name": p.name,
                    "model": p.model,
                    "tier": p.tier,
                    "enabled": p.enabled,
                    "free": p.is_free,
                    "fraction_remaining": round(self.ledger.forecast(p).fraction_remaining, 4),
                    "seconds_to_exhaustion": (
                        None
                        if self.ledger.forecast(p).seconds_to_exhaustion == float("inf")
                        else round(self.ledger.forecast(p).seconds_to_exhaustion, 1)
                    ),
                    "cooldown_remaining": max(0.0, self._cooldowns.get(p.name, 0.0) - now),
                }
                for p in self.providers
            ],
        }
