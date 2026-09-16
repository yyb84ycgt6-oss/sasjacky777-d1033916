"""Native Anthropic Messages API adapter."""

import io
import json
import urllib.error

import pytest

from jackierouter import ProviderError, RateLimited, RouteRequest
from jackierouter.anthropic_adapter import (
    PRICING_PER_1K,
    AnthropicAdapter,
    split_system,
)


class FakeResponse:
    def __init__(self, payload=None, lines=None):
        self._payload = payload
        self._lines = lines or []

    def read(self):
        return json.dumps(self._payload).encode()

    def __iter__(self):
        return iter(line.encode() for line in self._lines)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def http_error(code, headers=None):
    return urllib.error.HTTPError(
        url="https://api.anthropic.com/v1/messages", code=code, msg="no",
        hdrs=headers or {}, fp=io.BytesIO(b'{"error":{"message":"nope"}}'),
    )


@pytest.fixture
def request_obj():
    return RouteRequest(messages=[{"role": "user", "content": "hi"}], max_output_tokens=256)


def test_system_messages_are_hoisted_to_the_top_level_field():
    """The handoff briefing arrives as a system message — this is the seam
    that makes failover *to* Claude work at all."""
    system, conversation = split_system(
        [
            {"role": "system", "content": "briefing text"},
            {"role": "user", "content": "task"},
        ]
    )
    assert system == "briefing text"
    assert conversation == [{"role": "user", "content": "task"}]


def test_multiple_system_messages_are_joined():
    system, _ = split_system(
        [{"role": "system", "content": "a"}, {"role": "system", "content": "b"},
         {"role": "user", "content": "c"}]
    )
    assert system == "a\n\nb"


def test_a_system_only_payload_still_produces_a_message():
    """The API requires at least one message; an empty list would 400."""
    system, conversation = split_system([{"role": "system", "content": "only this"}])
    assert len(conversation) == 1
    assert conversation[0]["role"] == "user"


def test_request_body_shape(monkeypatch, request_obj):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data.decode())
        captured["headers"] = dict(request.header_items())
        return FakeResponse({"content": [{"type": "text", "text": "ok"}], "usage": {}})

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    AnthropicAdapter("claude-opus-5").complete(
        [{"role": "system", "content": "brief"}, {"role": "user", "content": "hi"}], request_obj
    )

    assert captured["url"].endswith("/v1/messages")
    assert captured["body"]["model"] == "claude-opus-5"
    assert captured["body"]["max_tokens"] == 256
    assert captured["body"]["system"] == "brief"
    assert captured["body"]["messages"] == [{"role": "user", "content": "hi"}]
    headers = {k.lower(): v for k, v in captured["headers"].items()}
    assert headers["x-api-key"] == "sk-ant-test"
    assert headers["anthropic-version"] == "2023-06-01"


def test_text_blocks_are_concatenated_and_usage_read(monkeypatch, request_obj):
    payload = {
        "content": [
            {"type": "thinking", "thinking": ""},
            {"type": "text", "text": "first "},
            {"type": "text", "text": "second"},
        ],
        "usage": {"input_tokens": 120, "output_tokens": 34},
        "stop_reason": "end_turn",
    }
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResponse(payload))
    result = AnthropicAdapter("claude-opus-5").complete(request_obj.messages, request_obj)
    assert result.text == "first second"
    assert (result.input_tokens, result.output_tokens) == (120, 34)


def test_a_refusal_is_returned_not_raised(monkeypatch, request_obj):
    """A refusal is the model's answer, not an outage. Raising would make the
    router shop the same prompt around until one provider complies."""
    payload = {
        "content": [{"type": "text", "text": "I can't help with that."}],
        "usage": {"input_tokens": 10, "output_tokens": 8},
        "stop_reason": "refusal",
        "stop_details": {"type": "refusal", "category": "cyber"},
    }
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResponse(payload))
    result = AnthropicAdapter("claude-opus-5").complete(request_obj.messages, request_obj)
    assert result.raw["stop_reason"] == "refusal"
    assert result.text


def test_429_becomes_rate_limited_with_retry_after(monkeypatch, request_obj):
    def boom(*args, **kwargs):
        raise http_error(429, {"retry-after": "23"})

    monkeypatch.setattr("urllib.request.urlopen", boom)
    with pytest.raises(RateLimited) as excinfo:
        AnthropicAdapter("claude-opus-5").complete(request_obj.messages, request_obj)
    assert excinfo.value.retry_after == 23.0


def test_overloaded_cools_down_briefly_and_auth_errors_cool_down_long(monkeypatch, request_obj):
    adapter = AnthropicAdapter("claude-opus-5")

    monkeypatch.setattr("urllib.request.urlopen",
                        lambda *a, **k: (_ for _ in ()).throw(http_error(529)))
    with pytest.raises(ProviderError) as overloaded:
        adapter.complete(request_obj.messages, request_obj)

    monkeypatch.setattr("urllib.request.urlopen",
                        lambda *a, **k: (_ for _ in ()).throw(http_error(401)))
    with pytest.raises(ProviderError) as unauthorized:
        adapter.complete(request_obj.messages, request_obj)

    assert overloaded.value.retry_after < unauthorized.value.retry_after


def test_streaming_parses_sse_events(monkeypatch, request_obj):
    lines = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":42}}}\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n',
        'data: {"type":"message_delta","usage":{"output_tokens":7}}\n',
        'data: {"type":"message_stop"}\n',
    ]
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResponse(lines=lines))

    events = list(AnthropicAdapter("claude-opus-5").stream(request_obj.messages, request_obj))
    assert [e.text for e in events if e.text] == ["Hel", "lo"]
    done = events[-1]
    assert done.done and done.input_tokens == 42 and done.output_tokens == 7


def test_an_overloaded_error_mid_stream_is_a_failover_signal(monkeypatch, request_obj):
    lines = [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"par"}}\n',
        'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n',
    ]
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResponse(lines=lines))

    stream = AnthropicAdapter("claude-opus-5").stream(request_obj.messages, request_obj)
    assert next(stream).text == "par"
    with pytest.raises(ProviderError):
        next(stream)


def test_published_pricing_is_looked_up_by_model():
    assert AnthropicAdapter.pricing_for("claude-opus-5") == (0.005, 0.025)
    assert AnthropicAdapter.pricing_for("claude-sonnet-5") == (0.002, 0.010)
    assert AnthropicAdapter.pricing_for("not-a-model") is None


def test_pricing_table_is_dollars_per_thousand_not_per_million():
    """A units slip here would under-bill by 1000x and defeat every cap."""
    for model, (input_rate, output_rate) in PRICING_PER_1K.items():
        assert 0.0001 < input_rate < 1.0, model
        assert output_rate >= input_rate, model
