import math

from jackierouter import Limit, Provider, QuotaLedger, Usage


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def provider(**kwargs):
    kwargs.setdefault("name", "p")
    kwargs.setdefault("model", "m")
    kwargs.setdefault("adapter", None)
    return Provider(**kwargs)


def test_unmetered_provider_never_forecasts_exhaustion():
    ledger = QuotaLedger(time_fn=Clock())
    forecast = ledger.forecast(provider())
    assert forecast.seconds_to_exhaustion == math.inf
    assert not forecast.at_risk(3600)


def test_forecast_predicts_exhaustion_from_burn_rate():
    clock = Clock()
    ledger = QuotaLedger(time_fn=clock)
    p = provider(limits=[Limit(60, requests=10, label="rpm")])

    for _ in range(5):
        ledger.record("p", Usage(requests=1))
        clock.advance(1)

    forecast = ledger.forecast(p)
    # 5 used over a 5s span = 1/s, 5 left => ~5s.
    assert 4.0 <= forecast.seconds_to_exhaustion <= 6.0
    assert forecast.fraction_remaining == 0.5
    assert forecast.limiting_window == "rpm"


def test_at_risk_fires_with_headroom_left():
    """The whole point: warn before the wall, not at it."""
    clock = Clock()
    ledger = QuotaLedger(time_fn=clock)
    p = provider(limits=[Limit(60, requests=20, label="rpm")])

    for _ in range(10):
        ledger.record("p", Usage(requests=1))
        clock.advance(1)

    forecast = ledger.forecast(p)
    assert forecast.fraction_remaining == 0.5  # half the quota is still there
    assert forecast.at_risk(horizon_seconds=30)  # and it is still flagged
    assert not forecast.exhausted


def test_token_limit_can_be_the_binding_constraint():
    clock = Clock()
    ledger = QuotaLedger(time_fn=clock)
    p = provider(
        limits=[Limit(60, requests=1000, label="rpm"), Limit(60, tokens=1000, label="tpm")]
    )

    ledger.record("p", Usage(input_tokens=400, output_tokens=400))
    clock.advance(1)

    forecast = ledger.forecast(p)
    assert forecast.limiting_window == "tpm"
    assert forecast.fraction_remaining == 0.2


def test_events_age_out_of_the_window():
    clock = Clock()
    ledger = QuotaLedger(time_fn=clock)
    p = provider(limits=[Limit(60, requests=10)])

    for _ in range(10):
        ledger.record("p", Usage(requests=1))
    assert ledger.forecast(p).exhausted

    clock.advance(61)
    assert ledger.forecast(p).fraction_remaining == 1.0


def test_would_exceed_rejects_a_call_that_cannot_fit():
    ledger = QuotaLedger(time_fn=Clock())
    p = provider(limits=[Limit(60, tokens=1000)])
    ledger.record("p", Usage(input_tokens=900))

    assert ledger.would_exceed(p, tokens=200)
    assert not ledger.would_exceed(p, tokens=50)


def test_rejections_still_consume_a_request_slot():
    ledger = QuotaLedger(time_fn=Clock())
    p = provider(limits=[Limit(60, requests=2)])
    ledger.record_rejection("p")
    assert ledger.forecast(p).fraction_remaining == 0.5
