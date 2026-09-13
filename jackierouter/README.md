# jackierouter

Predictive, cost-tiered AI routing with context-preserving failover.

Most multi-provider setups are a `try/except` around one API call: run until a
429, then panic. That fails the request that hits the wall, and whatever the
model was halfway through writing is gone.

This library does three things instead:

1. **Forecasts exhaustion instead of waiting for it.** A sliding-window ledger
   measures burn rate per provider and predicts seconds-to-exhaustion, so the
   router migrates while headroom remains.
2. **Climbs the cost ladder only when it must.** Tier 0 is hardware you own. A
   paid provider is never reached for while a free one is healthy, and rolling
   spend caps are the hard stop behind that.
3. **Carries the thread across.** Every failover attaches a briefing built from
   the interrupted turn — the task, what was established, and the tail of the
   partial output — so the next model continues mid-thought.

No third-party dependencies in the core. `pip install jackierouter[gateway]`
adds FastAPI if you want it on a port.

## Use

```python
from jackierouter import RouteRequest, router_from_env

router = router_from_env()  # reads $JACKIEROUTER_CONFIG
result = router.dispatch(RouteRequest(
    messages=[{"role": "user", "content": "write the down-migration"}],
    capability="code",
))

print(result.text)
print(result.provider, result.model, result.cost, result.handoffs)
for attempt in result.trace:
    print(attempt.provider, attempt.outcome, attempt.detail)
```

Building the ladder by hand instead of from config:

```python
from jackierouter import BudgetGuardian, Limit, OllamaAdapter, OpenAICompatAdapter, Provider, Router

router = Router(
    [
        Provider(
            name="local/qwen",
            model="qwen3.5:latest",
            adapter=OllamaAdapter("qwen3.5:latest"),
            tier=0,
            max_context=32768,
        ),
        Provider(
            name="groq/llama-70b",
            model="llama-3.3-70b-versatile",
            adapter=OpenAICompatAdapter(
                "llama-3.3-70b-versatile",
                base_url="https://api.groq.com/openai/v1",
                api_key_env="GROQ_API_KEY",
            ),
            tier=1,
            limits=[Limit(60, requests=30, label="rpm"), Limit(60, tokens=12000, label="tpm")],
        ),
    ],
    budget=BudgetGuardian.hourly_daily(per_hour=0.50, per_day=5.00),
    horizon_seconds=30,
)
```

## Configuration

One JSON document describes the whole ladder; see
`../router.config.example.json`. Point `JACKIEROUTER_CONFIG` at it.

| field | meaning |
| --- | --- |
| `tier` | cost ladder rung. 0 = your own hardware. The router never climbs while a lower rung is healthy. |
| `limits[]` | declared rate limits: `window_seconds` plus `requests` and/or `tokens`. This is what the forecast is computed against. |
| `cost_per_1k_input` / `cost_per_1k_output` | prices, used for both estimates and recorded spend. |
| `capabilities[]` | free-form tags (`code`, `chat`, `long-context`, `vision`). A request asking for one only sees providers that declare it. |
| `max_context` | requests estimated larger than this skip the provider. |
| `horizon_seconds` | how far ahead the forecast looks. A provider expected to run dry inside it is "at risk". |
| `risk_policy` | `migrate` (default): healthy beats cheap, so the move happens early. `conserve`: cheap beats healthy, so a free rung is used until it is genuinely spent. |
| `budget` | `per_hour` / `per_day` spend caps. Omit for local-only. |

## Adapters

`OpenAICompatAdapter` posts to `{base_url}/chat/completions` with a bearer
token. The Anthropic entry in the example config points at Anthropic's
OpenAI-compatible endpoint for that reason — the native `/v1/messages` API has
a different shape and would need its own adapter.

An adapter is anything with:

```python
def complete(self, messages, request) -> AdapterResult: ...
```

raising `RateLimited` or `ProviderError` on failure. `OllamaAdapter`,
`OpenAICompatAdapter` (OpenAI, Groq, Together, vLLM, LM Studio) and
`EchoAdapter` ship with the library. An adapter may attach `partial_output` to
the exception it raises; the router folds that into the handoff briefing so the
next model resumes from the exact cut point.

## Operating it

`router.status()` returns live per-provider headroom, seconds-to-exhaustion,
cooldowns, and spend against each cap — the same payload the gateway serves at
`GET /status`.

## Tests

```
python -m pytest
```

No network, no sleeping: the clock is injected, so the forecasting logic is
tested deterministically.
