import io
import urllib.error

import pytest

from jackierouter import OllamaAdapter, OpenAICompatAdapter, ProviderError, RateLimited, RouteRequest
from jackierouter import adapters
from jackierouter.adapters import flatten


def http_error(code, headers=None):
    return urllib.error.HTTPError(
        url="http://x", code=code, msg="nope", hdrs=headers or {}, fp=io.BytesIO(b"detail")
    )


@pytest.fixture
def request_obj():
    return RouteRequest(messages=[{"role": "user", "content": "hi"}])


def test_flatten_keeps_a_single_user_prompt_clean():
    assert flatten([{"role": "user", "content": "hello"}]) == "hello"


def test_flatten_labels_roles_in_a_transcript():
    text = flatten(
        [{"role": "system", "content": "be brief"}, {"role": "user", "content": "hello"}]
    )
    assert "system: be brief" in text and "user: hello" in text


def test_ollama_parses_reported_token_counts(monkeypatch, request_obj):
    monkeypatch.setattr(
        adapters,
        "_post_json",
        lambda *a, **k: {"response": "hi back", "prompt_eval_count": 12, "eval_count": 34},
    )
    result = OllamaAdapter("qwen3.5:latest").complete(request_obj.messages, request_obj)
    assert (result.text, result.input_tokens, result.output_tokens) == ("hi back", 12, 34)


def test_unreachable_local_box_is_a_routing_signal_not_a_crash(monkeypatch, request_obj):
    def boom(*args, **kwargs):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(adapters, "_post_json", boom)
    with pytest.raises(ProviderError) as excinfo:
        OllamaAdapter("qwen3.5:latest").complete(request_obj.messages, request_obj)
    assert excinfo.value.retry_after == 15.0


def test_429_maps_to_rate_limited_and_honours_retry_after(monkeypatch, request_obj):
    def boom(*args, **kwargs):
        raise http_error(429, {"Retry-After": "17"})

    monkeypatch.setattr(adapters, "_post_json", boom)
    adapter = OpenAICompatAdapter("m", base_url="https://api.example/v1")
    with pytest.raises(RateLimited) as excinfo:
        adapter.complete(request_obj.messages, request_obj)
    assert excinfo.value.retry_after == 17.0


def test_server_errors_cool_down_briefly_and_client_errors_cool_down_long(monkeypatch, request_obj):
    adapter = OpenAICompatAdapter("m", base_url="https://api.example/v1")

    monkeypatch.setattr(adapters, "_post_json", lambda *a, **k: (_ for _ in ()).throw(http_error(503)))
    with pytest.raises(ProviderError) as transient:
        adapter.complete(request_obj.messages, request_obj)

    monkeypatch.setattr(adapters, "_post_json", lambda *a, **k: (_ for _ in ()).throw(http_error(401)))
    with pytest.raises(ProviderError) as permanent:
        adapter.complete(request_obj.messages, request_obj)

    assert transient.value.retry_after < permanent.value.retry_after


def test_openai_adapter_reads_usage_and_content(monkeypatch, request_obj):
    monkeypatch.setattr(
        adapters,
        "_post_json",
        lambda *a, **k: {
            "choices": [{"message": {"content": "answer"}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 7},
        },
    )
    adapter = OpenAICompatAdapter("m", base_url="https://api.example/v1")
    result = adapter.complete(request_obj.messages, request_obj)
    assert (result.text, result.input_tokens, result.output_tokens) == ("answer", 5, 7)


def test_api_key_comes_from_the_environment(monkeypatch, request_obj):
    seen = {}

    def capture(url, payload, headers, timeout):
        seen.update(headers)
        return {"choices": [{"message": {"content": "ok"}}]}

    monkeypatch.setenv("TEST_PROVIDER_KEY", "sk-secret")
    monkeypatch.setattr(adapters, "_post_json", capture)
    adapter = OpenAICompatAdapter("m", base_url="https://api.example/v1", api_key_env="TEST_PROVIDER_KEY")
    adapter.complete(request_obj.messages, request_obj)
    assert seen["Authorization"] == "Bearer sk-secret"


def test_missing_api_key_sends_no_authorization_header(monkeypatch, request_obj):
    seen = {"Authorization": "should be removed"}

    def capture(url, payload, headers, timeout):
        seen.clear()
        seen.update(headers)
        return {"choices": [{"message": {"content": "ok"}}]}

    monkeypatch.delenv("ABSENT_KEY", raising=False)
    monkeypatch.setattr(adapters, "_post_json", capture)
    adapter = OpenAICompatAdapter("m", base_url="https://api.example/v1", api_key_env="ABSENT_KEY")
    adapter.complete(request_obj.messages, request_obj)
    assert "Authorization" not in seen
