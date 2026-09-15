#!/usr/bin/env python3
"""Offline proof that the ladder works. No network, no API keys.

Three providers: a local box that is asleep, a free cloud tier that runs dry
mid-conversation, and a paid model. Watch the router move before the wall and
hand the thread across.

    python examples/demo_failover.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jackierouter import (  # noqa: E402
    AdapterResult,
    BudgetGuardian,
    Limit,
    Provider,
    RateLimited,
    RouteRequest,
    Router,
    Usage,
)


class SleepingBox:
    """The RTX box is off, or thermally gated. A routing signal, not a crash."""

    def complete(self, messages, request):
        raise RateLimited("local box unreachable", provider="local/qwen", retry_after=120)


class FreeTier:
    """Answers, but only so many times a minute."""

    def complete(self, messages, request):
        return AdapterResult(text="…schema diff drafted…", input_tokens=400, output_tokens=200)


class PaidModel:
    def complete(self, messages, request):
        resumed = any("Do not restart" in m.get("content", "") for m in messages)
        return AdapterResult(
            text=(
                "COMMIT;  -- resumed mid-thought, briefing received"
                if resumed
                else "COMMIT;  -- fresh start, no handoff was needed"
            ),
            input_tokens=600,
            output_tokens=120,
        )


def main() -> None:
    router = Router(
        [
            Provider(name="local/qwen", model="qwen3.5", adapter=SleepingBox(), tier=0),
            Provider(
                name="groq/llama-70b",
                model="llama-3.3-70b",
                adapter=FreeTier(),
                tier=1,
                limits=[Limit(60, requests=10, label="rpm")],
            ),
            Provider(
                name="anthropic/sonnet",
                model="claude-sonnet-5",
                adapter=PaidModel(),
                tier=2,
                cost_per_1k_input=0.003,
                cost_per_1k_output=0.015,
            ),
        ],
        budget=BudgetGuardian.hourly_daily(per_hour=0.50, per_day=5.00),
        horizon_seconds=30,
    )

    request = RouteRequest(
        messages=[
            {"role": "user", "content": "Port the payments migration to Postgres 16."},
            {"role": "assistant", "content": "Starting with the schema diff."},
            {"role": "user", "content": "Now write the down-migration."},
        ],
        capability=None,
        max_output_tokens=256,
    )

    print("1. Local box is asleep — the router finds that out and moves on.\n")
    result = router.dispatch(request)
    for attempt in result.trace:
        print(f"   {attempt.provider:<18} {attempt.outcome:<12} {attempt.detail[:46]}")
    print(f"   -> served by {result.provider} after {result.handoffs} handoff(s)\n")

    print("2. Burn the free tier down. Note it still has quota left.\n")
    for _ in range(6):
        router.ledger.record("groq/llama-70b", Usage(requests=1))

    free = next(p for p in router.providers if p.name == "groq/llama-70b")
    forecast = router.ledger.forecast(free)
    print(f"   {forecast.describe()}  (exhausted={forecast.exhausted})\n")

    print("3. Same request again — the router escalates *before* the 429.")
    print("   (No briefing this time: nothing was interrupted, so nothing was lost.)\n")
    result = router.dispatch(request)
    for attempt in result.trace:
        print(f"   {attempt.provider:<18} {attempt.outcome:<12} {attempt.detail[:46]}")
    print(f"   -> served by {result.provider}, cost ${result.cost:.4f}")
    print(f"   -> answer: {result.text}\n")

    print("4. Live vital signs:\n")
    status = router.status()
    for provider in status["providers"]:
        headroom = f"{provider['fraction_remaining']:.0%}"
        cooldown = provider["cooldown_remaining"]
        print(
            f"   {provider['name']:<18} tier {provider['tier']}  headroom {headroom:>4}"
            f"  cooldown {cooldown:>5.0f}s"
        )
    print(f"\n   budget: {status['budget']}")


if __name__ == "__main__":
    main()
