import pytest

from jackierouter import (
    AdapterResult,
    BudgetGuardian,
    CONSERVE,
    Limit,
    MIGRATE,
    NoProviderAvailable,
    Provider,
    ProviderError,
    QuotaLedger,
    RateLimited,
    RouteRequest,
    Router,
    Usage,
)


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeAdapter:
    """Records what it was asked, and fails on cue."""

    def __init__(self, name, reply="done", fail_with=None, input_tokens=None, output_tokens=None):
        self.name = name
        self.reply = reply
        self.fail_with = fail_with
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.calls = []

    def complete(self, messages, request):
        self.calls.append(list(messages))
        if self.fail_with is not None:
            raise self.fail_with
        return AdapterResult(
            text=self.reply,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
        )


def provider(name, adapter, **kwargs):
    kwargs.setdefault("model", name)
    return Provider(name=name, adapter=adapter, **kwargs)


def ask(text="write the down-migration"):
    return RouteRequest(messages=[{"role": "user", "content": text}])


def test_cheapest_healthy_provider_wins():
    local = FakeAdapter("local", reply="from local")
    cloud = FakeAdapter("cloud", reply="from cloud")
    router = Router(
        [
            provider("cloud", cloud, tier=2, cost_per_1k_input=0.003, cost_per_1k_output=0.015),
            provider("local", local, tier=0),
        ],
        time_fn=Clock(),
    )

    result = router.dispatch(ask())
    assert result.provider == "local"
    assert result.cost == 0.0
    assert cloud.calls == []


def test_migrates_to_a_healthy_peer_before_the_wall():
    clock = Clock()
    hot = FakeAdapter("hot")
    cool = FakeAdapter("cool")
    hot_provider = provider("hot", hot, tier=0, limits=[Limit(60, requests=20, label="rpm")])
    cool_provider = provider("cool", cool, tier=0, limits=[Limit(60, requests=20, label="rpm")])
    ledger = QuotaLedger(time_fn=clock)
    router = Router(
        [hot_provider, cool_provider], ledger=ledger, horizon_seconds=30, time_fn=clock
    )

    # Burn "hot" hard but leave half its quota untouched.
    for _ in range(10):
        ledger.record("hot", Usage(requests=1))
        clock.advance(1)

    assert ledger.forecast(hot_provider).fraction_remaining == 0.5  # headroom remains
    result = router.dispatch(ask())
    assert result.provider == "cool"  # and we moved anyway


def test_migrate_policy_escalates_when_every_free_rung_is_at_risk():
    clock = Clock()
    ledger = QuotaLedger(time_fn=clock)
    free = provider("free", FakeAdapter("free"), tier=0, limits=[Limit(60, requests=20)])
    paid = provider(
        "paid", FakeAdapter("paid"), tier=1, cost_per_1k_input=0.001, cost_per_1k_output=0.002
    )
    router = Router([free, paid], ledger=ledger, horizon_seconds=30, time_fn=clock)

    for _ in range(10):
        ledger.record("free", Usage(requests=1))
        clock.advance(1)

    assert router.dispatch(ask()).provider == "paid"


def test_conserve_policy_stays_on_the_free_rung_until_it_is_spent():
    clock = Clock()
    ledger = QuotaLedger(time_fn=clock)
    free = provider("free", FakeAdapter("free"), tier=0, limits=[Limit(60, requests=20)])
    paid = provider("paid", FakeAdapter("paid"), tier=1, cost_per_1k_input=0.001)
    router = Router(
        [free, paid], ledger=ledger, horizon_seconds=30, risk_policy=CONSERVE, time_fn=clock
    )

    for _ in range(10):
        ledger.record("free", Usage(requests=1))
        clock.advance(1)

    assert router.dispatch(ask()).provider == "free"


def test_rate_limit_fails_over_with_a_briefing_attached():
    limited = FakeAdapter("limited", fail_with=RateLimited("quota spent", provider="limited"))
    backup = FakeAdapter("backup", reply="continued")
    router = Router(
        [provider("limited", limited, tier=0), provider("backup", backup, tier=1)],
        time_fn=Clock(),
    )

    result = router.dispatch(ask())

    assert result.provider == "backup"
    assert result.text == "continued"
    assert result.handoffs == 1
    handed = backup.calls[0]
    assert handed[0]["role"] == "system"
    assert "Do not restart" in handed[0]["content"]
    assert "write the down-migration" in handed[0]["content"]


def test_partial_output_survives_the_handoff():
    exc = RateLimited("cut off mid-sentence", provider="limited")
    exc.partial_output = "BEGIN;\nALTER TABLE payments DROP COLUMN"
    limited = FakeAdapter("limited", fail_with=exc)
    backup = FakeAdapter("backup")
    router = Router(
        [provider("limited", limited, tier=0), provider("backup", backup, tier=1)],
        time_fn=Clock(),
    )

    router.dispatch(ask())
    assert "ALTER TABLE payments DROP COLUMN" in backup.calls[0][0]["content"]


def test_an_adapter_bug_does_not_end_the_ladder():
    broken = FakeAdapter("broken", fail_with=ValueError("adapter is buggy"))
    backup = FakeAdapter("backup", reply="ok")
    router = Router(
        [provider("broken", broken, tier=0), provider("backup", backup, tier=1)],
        time_fn=Clock(),
    )

    result = router.dispatch(ask())
    assert result.provider == "backup"
    assert any(a.outcome == "error" for a in result.trace)


def test_failed_provider_is_skipped_while_cooling_down():
    clock = Clock()
    limited = FakeAdapter("limited", fail_with=RateLimited("spent", provider="limited", retry_after=60))
    backup = FakeAdapter("backup")
    router = Router(
        [provider("limited", limited, tier=0), provider("backup", backup, tier=1)],
        time_fn=clock,
    )

    router.dispatch(ask())
    router.dispatch(ask())
    assert len(limited.calls) == 1  # not retried during the cooldown

    clock.advance(61)
    limited.fail_with = None
    assert router.dispatch(ask()).provider == "limited"


def test_budget_cap_keeps_a_paid_provider_out_of_the_ladder():
    budget = BudgetGuardian.hourly_daily(0.0001, 0.0001, time_fn=Clock())
    paid = FakeAdapter("paid")
    router = Router(
        [provider("paid", paid, tier=1, cost_per_1k_input=1.0, cost_per_1k_output=1.0)],
        budget=budget,
        time_fn=Clock(),
    )

    with pytest.raises(NoProviderAvailable) as excinfo:
        router.dispatch(ask())
    assert paid.calls == []
    assert any("budget cap" in a.detail for a in excinfo.value.trace)


def test_spend_is_recorded_against_the_budget():
    budget = BudgetGuardian.hourly_daily(1.0, 10.0, time_fn=Clock())
    paid = FakeAdapter("paid", input_tokens=1000, output_tokens=1000)
    router = Router(
        [provider("paid", paid, tier=1, cost_per_1k_input=0.01, cost_per_1k_output=0.03)],
        budget=budget,
        time_fn=Clock(),
    )

    result = router.dispatch(ask())
    assert result.cost == pytest.approx(0.04)
    assert budget.snapshot()["hourly"]["spent"] == pytest.approx(0.04)


def test_reported_usage_feeds_the_ledger():
    clock = Clock()
    ledger = QuotaLedger(time_fn=clock)
    adapter = FakeAdapter("p", input_tokens=800, output_tokens=200)
    p = provider("p", adapter, tier=0, limits=[Limit(60, tokens=2000, label="tpm")])
    router = Router([p], ledger=ledger, time_fn=clock)

    router.dispatch(ask())
    assert ledger.forecast(p).fraction_remaining == 0.5


def test_request_too_large_for_a_context_window_is_skipped():
    small = FakeAdapter("small")
    big = FakeAdapter("big")
    router = Router(
        [provider("small", small, tier=0, max_context=32), provider("big", big, tier=1, max_context=100000)],
        time_fn=Clock(),
    )

    request = RouteRequest(messages=[{"role": "user", "content": "x" * 4000}])
    result = router.dispatch(request)
    assert result.provider == "big"
    assert any(a.outcome == "skipped" and "context" in a.detail for a in result.trace)


def test_capability_filter_excludes_providers_that_lack_it():
    chat = FakeAdapter("chat")
    coder = FakeAdapter("coder")
    router = Router(
        [
            provider("chat", chat, tier=0, capabilities=frozenset({"chat"})),
            provider("coder", coder, tier=1, capabilities=frozenset({"code"})),
        ],
        time_fn=Clock(),
    )

    request = RouteRequest(messages=[{"role": "user", "content": "refactor this"}], capability="code")
    assert router.dispatch(request).provider == "coder"


def test_pin_forces_one_provider_and_fails_loudly():
    cheap = FakeAdapter("cheap")
    pinned = FakeAdapter("pinned", fail_with=ProviderError("down", provider="pinned"))
    router = Router(
        [provider("cheap", cheap, tier=0), provider("pinned", pinned, tier=1)],
        time_fn=Clock(),
    )

    request = RouteRequest(messages=[{"role": "user", "content": "hi"}], pin="pinned")
    with pytest.raises(NoProviderAvailable):
        router.dispatch(request)
    assert cheap.calls == []  # a pin is an instruction, not a preference


def test_no_providers_at_all_raises_with_a_trace():
    router = Router([provider("off", FakeAdapter("off"), tier=0, enabled=False)], time_fn=Clock())
    with pytest.raises(NoProviderAvailable) as excinfo:
        router.dispatch(ask())
    assert excinfo.value.trace[0].detail == "disabled"


def test_status_reports_every_provider():
    router = Router([provider("a", FakeAdapter("a"), tier=0)], time_fn=Clock())
    status = router.status()
    assert status["providers"][0]["name"] == "a"
    assert status["risk_policy"] == MIGRATE


def test_pin_that_matches_nothing_says_so():
    router = Router([provider("real", FakeAdapter("real"), tier=0)], time_fn=Clock())
    request = RouteRequest(messages=[{"role": "user", "content": "hi"}], pin="imaginary")

    with pytest.raises(NoProviderAvailable) as excinfo:
        router.dispatch(request)
    assert "not configured" in excinfo.value.trace[0].detail


def test_ladder_stops_after_max_attempts():
    adapters = [
        FakeAdapter(f"p{i}", fail_with=ProviderError("down", provider=f"p{i}")) for i in range(5)
    ]
    router = Router(
        [provider(f"p{i}", a, tier=i) for i, a in enumerate(adapters)],
        max_attempts=2,
        time_fn=Clock(),
    )

    with pytest.raises(NoProviderAvailable):
        router.dispatch(ask())
    assert sum(len(a.calls) for a in adapters) == 2  # not all five timeouts in series


def test_budget_exhausted_mid_ladder_stops_the_escalation():
    """The cap is re-checked per rung, not only when the plan was drawn."""
    clock = Clock()
    budget = BudgetGuardian.hourly_daily(0.05, 1.0, time_fn=clock)
    first = FakeAdapter("first", fail_with=RateLimited("spent", provider="first"))
    second = FakeAdapter("second")
    router = Router(
        [
            provider("first", first, tier=1, cost_per_1k_input=0.001),
            provider("second", second, tier=2, cost_per_1k_input=1.0, cost_per_1k_output=1.0),
        ],
        budget=budget,
        time_fn=clock,
    )

    budget.record(0.049)  # nearly spent after the plan was drawn
    with pytest.raises(NoProviderAvailable):
        router.dispatch(ask())
    assert second.calls == []


def test_budget_only_failure_raises_the_specific_error():
    from jackierouter import BudgetExceeded

    budget = BudgetGuardian.hourly_daily(0.0, 0.0, time_fn=Clock())
    router = Router(
        [provider("paid", FakeAdapter("paid"), tier=1, cost_per_1k_input=1.0)],
        budget=budget,
        time_fn=Clock(),
    )

    with pytest.raises(BudgetExceeded):
        router.dispatch(ask())
    # still catchable as the general case
    with pytest.raises(NoProviderAvailable):
        router.dispatch(ask())


def test_max_attempts_must_be_positive():
    with pytest.raises(ValueError):
        Router([provider("a", FakeAdapter("a"))], max_attempts=0)
