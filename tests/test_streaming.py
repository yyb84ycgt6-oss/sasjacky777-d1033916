"""Streaming, and the failover that makes streaming worth having."""

import pytest

from jackierouter import (
    BudgetGuardian,
    EchoAdapter,
    NoProviderAvailable,
    Provider,
    ProviderError,
    RateLimited,
    RouteRequest,
    Router,
)
from jackierouter.types import StreamEvent


class Streamer:
    def __init__(self, chunks, input_tokens=None, output_tokens=None, fail_after=None, error=None):
        self.chunks = chunks
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.fail_after = fail_after
        self.error = error
        self.seen = []

    def stream(self, messages, request):
        """Emit `fail_after` chunks, then die — or emit everything and finish."""
        self.seen.append(list(messages))
        for index, chunk in enumerate(self.chunks):
            if self.fail_after is not None and index >= self.fail_after:
                raise self.error
            yield StreamEvent(text=chunk)
        if self.fail_after is not None:
            raise self.error
        yield StreamEvent(
            done=True, input_tokens=self.input_tokens, output_tokens=self.output_tokens
        )


class NonStreaming:
    """An adapter with no stream() at all — must still work."""

    def __init__(self, reply="whole thing at once"):
        self.reply = reply

    def complete(self, messages, request):
        from jackierouter import AdapterResult

        return AdapterResult(text=self.reply, input_tokens=11, output_tokens=22)


def ask(text="write the down-migration"):
    return RouteRequest(messages=[{"role": "user", "content": text}])


def test_chunks_arrive_in_order_and_the_result_is_the_join():
    adapter = Streamer(["one ", "two ", "three"], input_tokens=5, output_tokens=9)
    router = Router([Provider(name="p", model="m", adapter=adapter, tier=0)])

    stream = router.stream(ask())
    chunks = list(stream)

    assert chunks == ["one ", "two ", "three"]
    assert stream.result.text == "one two three"
    assert stream.result.usage.output_tokens == 9
    assert stream.result.provider == "p"


def test_a_provider_that_dies_mid_stream_is_resumed_not_restarted():
    """The reader keeps one continuous response across a provider change."""
    dying = Streamer(
        ["BEGIN;\n", "ALTER TABLE payments "],
        fail_after=2,
        error=RateLimited("quota spent", provider="free"),
    )
    resuming = Streamer(["DROP COLUMN legacy_id;"], output_tokens=12)
    router = Router(
        [
            Provider(name="free", model="free-1", adapter=dying, tier=0),
            Provider(name="paid", model="paid-1", adapter=resuming, tier=1),
        ]
    )

    stream = router.stream(ask())
    text = "".join(stream)

    assert text == "BEGIN;\nALTER TABLE payments DROP COLUMN legacy_id;"
    assert stream.result.provider == "paid"
    assert stream.result.handoffs == 1

    # The second provider was told where the first one stopped.
    briefing = resuming.seen[0][0]
    assert briefing["role"] == "system"
    assert "ALTER TABLE payments" in briefing["content"]
    assert "Do not restart" in briefing["content"]


def test_text_already_shown_to_the_reader_is_never_repeated():
    first = Streamer(["Hello "], fail_after=1, error=ProviderError("died", provider="a"))
    second = Streamer(["world"])
    router = Router(
        [
            Provider(name="a", model="a", adapter=first, tier=0),
            Provider(name="b", model="b", adapter=second, tier=1),
        ]
    )
    assert "".join(router.stream(ask())) == "Hello world"


def test_an_adapter_without_stream_still_streams():
    router = Router([Provider(name="p", model="m", adapter=NonStreaming(), tier=0)])
    stream = router.stream(ask())
    assert list(stream) == ["whole thing at once"]
    assert stream.result.usage.input_tokens == 11


def test_echo_adapter_streams_word_by_word():
    router = Router([Provider(name="p", model="m", adapter=EchoAdapter(reply="a b c"), tier=0)])
    assert list(router.stream(ask())) == ["a", " b", " c"]


def test_streaming_records_usage_cost_and_budget():
    adapter = Streamer(["x"], input_tokens=1000, output_tokens=1000)
    budget = BudgetGuardian.hourly_daily(1.0, 10.0)
    router = Router(
        [Provider(name="p", model="m", adapter=adapter, tier=1,
                  cost_per_1k_input=0.005, cost_per_1k_output=0.025)],
        budget=budget,
    )
    stream = router.stream(ask())
    stream.text()

    assert stream.result.cost == pytest.approx(0.03)
    assert budget.snapshot()["hourly"]["spent"] == pytest.approx(0.03)


def test_streaming_respects_the_budget_cap():
    adapter = Streamer(["x"])
    router = Router(
        [Provider(name="p", model="m", adapter=adapter, tier=1, cost_per_1k_input=10.0)],
        budget=BudgetGuardian.hourly_daily(0.0, 0.0),
    )
    with pytest.raises(NoProviderAvailable):
        list(router.stream(ask()))
    assert adapter.seen == []


def test_every_provider_failing_mid_stream_raises_with_the_trace():
    error = ProviderError("down", provider="x")
    router = Router(
        [
            Provider(name="a", model="a", adapter=Streamer(["p"], fail_after=1, error=error), tier=0),
            Provider(name="b", model="b", adapter=Streamer(["q"], fail_after=1, error=error), tier=1),
        ]
    )
    stream = router.stream(ask())
    with pytest.raises(NoProviderAvailable) as excinfo:
        list(stream)
    assert len(excinfo.value.trace) == 2


def test_text_helper_consumes_the_whole_stream():
    router = Router([Provider(name="p", model="m", adapter=Streamer(["a", "b"]), tier=0)])
    stream = router.stream(ask())
    assert stream.text() == "ab"
    assert stream.result is not None
