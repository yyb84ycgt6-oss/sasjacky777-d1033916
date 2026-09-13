"""Quota and spend must survive the process that recorded them."""

import json
import os

from jackierouter import (
    BudgetGuardian,
    EchoAdapter,
    Limit,
    Provider,
    QuotaLedger,
    RouteRequest,
    Router,
    Usage,
)
from jackierouter.persistence import StateStore


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def provider(adapter=None):
    return Provider(
        name="free",
        model="m",
        adapter=adapter or EchoAdapter(),
        tier=0,
        limits=[Limit(3600, requests=10, label="hourly")],
    )


def test_burn_survives_a_restart(tmp_path):
    path = str(tmp_path / "state.json")
    store = lambda: StateStore(path, min_save_interval=0.0)  # noqa: E731

    first = Router([provider()], state_store=store())
    for _ in range(7):
        first.dispatch(RouteRequest(messages=[{"role": "user", "content": "hi"}]))
    before = first.ledger.forecast(first.providers[0]).fraction_remaining

    second = Router([provider()], state_store=store())
    assert second.ledger.forecast(second.providers[0]).fraction_remaining == before
    assert before == 0.3  # not a fresh quota


def test_spend_survives_a_restart(tmp_path):
    path = str(tmp_path / "state.json")
    paid = Provider(
        name="paid", model="m", adapter=EchoAdapter(), tier=1,
        cost_per_1k_input=1.0, cost_per_1k_output=1.0,
    )

    first = Router(
        [paid], budget=BudgetGuardian.hourly_daily(1.0, 10.0),
        state_store=StateStore(path, min_save_interval=0.0),
    )
    first.dispatch(RouteRequest(messages=[{"role": "user", "content": "hi"}]))
    spent = first.budget.snapshot()["hourly"]["spent"]
    assert spent > 0

    second = Router(
        [paid], budget=BudgetGuardian.hourly_daily(1.0, 10.0),
        state_store=StateStore(path, min_save_interval=0.0),
    )
    assert second.budget.snapshot()["hourly"]["spent"] == spent


def test_old_events_are_dropped_on_load(tmp_path):
    """State from last week must not count against today's window."""
    path = str(tmp_path / "state.json")
    wall = Clock(now=1_000_000.0)
    ledger = QuotaLedger(time_fn=Clock(now=500.0))
    ledger.record("free", Usage(requests=1))

    StateStore(path, wall_clock=wall).save(ledger=ledger)

    wall.advance(90000)  # a day and a bit later
    restored = QuotaLedger(time_fn=Clock(now=500.0))
    StateStore(path, wall_clock=wall).load(ledger=restored)
    assert restored.forecast(provider()).fraction_remaining == 1.0


def test_events_are_stored_as_wall_clock_not_monotonic(tmp_path):
    """A monotonic timestamp is meaningless in the next process."""
    path = str(tmp_path / "state.json")
    ledger = QuotaLedger(time_fn=Clock(now=42.0))  # tiny monotonic value
    ledger.record("free", Usage(requests=1))
    StateStore(path, wall_clock=lambda: 1_700_000_000.0).save(ledger=ledger)

    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    stored_at = payload["ledger"]["providers"]["free"][0]["at"]
    assert stored_at > 1_600_000_000  # a real timestamp, not 42


def test_a_clock_that_jumped_backwards_does_not_grant_free_quota(tmp_path):
    path = str(tmp_path / "state.json")
    ledger = QuotaLedger(time_fn=Clock(now=1000.0))
    ledger.record("free", Usage(requests=5))
    StateStore(path, wall_clock=lambda: 2000.0).save(ledger=ledger)

    # The machine comes back with a clock reading *earlier* than the save.
    restored = QuotaLedger(time_fn=Clock(now=1000.0))
    StateStore(path, wall_clock=lambda: 1500.0).load(ledger=restored)
    assert restored.forecast(provider()).fraction_remaining == 0.5  # still counted


def test_a_corrupt_state_file_is_ignored_not_fatal(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not json at all")
    ledger = QuotaLedger()
    assert StateStore(str(path)).load(ledger=ledger) is False
    assert ledger.forecast(provider()).fraction_remaining == 1.0


def test_a_state_file_from_a_future_version_is_ignored(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"version": 99, "ledger": {"providers": {}}}))
    assert StateStore(str(path)).load(ledger=QuotaLedger()) is False


def test_missing_state_file_is_a_clean_first_run(tmp_path):
    assert StateStore(str(tmp_path / "nope.json")).load(ledger=QuotaLedger()) is False


def test_an_unwritable_path_does_not_break_the_request(tmp_path):
    """Losing persistence must never lose the call that triggered it."""
    unwritable = tmp_path / "file.txt"
    unwritable.write_text("i am a file, not a directory")
    router = Router(
        [provider()],
        state_store=StateStore(str(unwritable / "state.json"), min_save_interval=0.0),
    )
    result = router.dispatch(RouteRequest(messages=[{"role": "user", "content": "hi"}]))
    assert result.text == "ok"


def test_saves_are_throttled_but_spending_always_forces_one(tmp_path):
    path = str(tmp_path / "state.json")
    wall = Clock(now=0.0)
    store = StateStore(path, min_save_interval=60.0, wall_clock=wall)

    assert store.maybe_save(ledger=QuotaLedger()) is True  # first save always happens
    assert store.maybe_save(ledger=QuotaLedger()) is False  # throttled
    assert store.maybe_save(ledger=QuotaLedger(), force=True) is True  # money


def test_state_file_is_written_atomically(tmp_path):
    """A half-written file must never be loadable."""
    path = tmp_path / "state.json"
    store = StateStore(str(path), min_save_interval=0.0)
    ledger = QuotaLedger()
    ledger.record("free", Usage(requests=1))
    store.save(ledger=ledger)

    leftovers = [p for p in os.listdir(tmp_path) if p.startswith(".jackierouter-")]
    assert leftovers == []  # temp file was renamed, not abandoned
    json.loads(path.read_text())
