from jackierouter import BudgetGuardian, SpendWindow


class Clock:
    def __init__(self, now=0.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def test_no_windows_permits_everything():
    guardian = BudgetGuardian(time_fn=Clock())
    assert guardian.can_spend(1_000_000.0)
    assert guardian.blocking_window(1_000_000.0) is None


def test_cap_blocks_and_names_the_window():
    guardian = BudgetGuardian.hourly_daily(0.50, 5.00, time_fn=Clock())
    guardian.record(0.45)
    assert not guardian.can_spend(0.10)
    assert guardian.blocking_window(0.10) == "hourly"
    assert guardian.can_spend(0.05)


def test_spend_ages_out_of_the_window():
    clock = Clock()
    guardian = BudgetGuardian([SpendWindow(3600.0, 1.0, label="hourly")], time_fn=clock)
    guardian.record(1.0)
    assert not guardian.can_spend(0.01)

    clock.advance(3601)
    assert guardian.can_spend(1.0)


def test_free_calls_are_always_permitted():
    guardian = BudgetGuardian.hourly_daily(0.0, 0.0, time_fn=Clock())
    guardian.record(0.0)
    assert guardian.can_spend(0.0)


def test_snapshot_reports_every_window():
    guardian = BudgetGuardian.hourly_daily(1.0, 10.0, time_fn=Clock())
    guardian.record(0.25)
    snapshot = guardian.snapshot()
    assert snapshot["hourly"]["remaining"] == 0.75
    assert snapshot["daily"]["remaining"] == 9.75
