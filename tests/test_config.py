import json

import pytest

from jackierouter import RouteRequest, Router
from jackierouter.config import build_provider, build_router, load_config, router_from_env


def test_default_config_builds_a_local_only_router(monkeypatch):
    monkeypatch.delenv("JACKIEROUTER_CONFIG", raising=False)
    router = build_router(load_config())
    assert all(p.tier == 0 and p.is_free for p in router.providers)


def test_provider_spec_becomes_a_full_provider():
    provider = build_provider(
        {
            "name": "groq/llama",
            "kind": "openai",
            "model": "llama-3.3-70b",
            "base_url": "https://api.groq.com/openai/v1",
            "api_key_env": "GROQ_API_KEY",
            "tier": 1,
            "max_context": 128000,
            "capabilities": ["chat", "code"],
            "limits": [
                {"window_seconds": 60, "requests": 30, "label": "rpm"},
                {"window_seconds": 86400, "tokens": 500000, "label": "daily"},
            ],
        }
    )
    assert provider.tier == 1
    assert provider.is_free
    assert {limit.name() for limit in provider.limits} == {"rpm", "daily"}
    assert provider.supports("code") and not provider.supports("vision")


def test_budget_windows_come_from_config():
    router = build_router(
        {
            "providers": [{"name": "e", "kind": "echo", "model": "echo"}],
            "budget": {"per_hour": 0.25, "per_day": 2.0},
        }
    )
    assert set(router.budget.snapshot()) == {"hourly", "daily"}


def test_unknown_provider_kind_is_rejected():
    with pytest.raises(ValueError):
        build_provider({"name": "x", "kind": "telepathy", "model": "m"})


def test_unknown_risk_policy_is_rejected():
    with pytest.raises(ValueError):
        build_router({"providers": [{"name": "e", "kind": "echo", "model": "echo"}], "risk_policy": "vibes"})


def test_empty_provider_list_is_rejected():
    with pytest.raises(ValueError):
        build_router({"providers": []})


def test_config_is_loaded_from_the_environment(tmp_path, monkeypatch):
    path = tmp_path / "router.json"
    path.write_text(
        json.dumps({"providers": [{"name": "e", "kind": "echo", "model": "echo", "reply": "hello"}]})
    )
    monkeypatch.setenv("JACKIEROUTER_CONFIG", str(path))

    router = router_from_env()
    assert isinstance(router, Router)
    result = router.dispatch(RouteRequest(messages=[{"role": "user", "content": "hi"}]))
    assert result.text == "hello"


def test_default_config_is_not_shared_between_callers():
    first = load_config()
    first["providers"].clear()
    assert load_config()["providers"]  # mutating one copy must not poison the next


def test_zero_cap_means_spend_nothing_not_unlimited():
    router = build_router(
        {
            "providers": [{"name": "e", "kind": "echo", "model": "echo"}],
            "budget": {"per_hour": 0.0, "per_day": 0.0},
        }
    )
    assert not router.budget.can_spend(0.01)


def test_omitting_the_budget_means_no_cap():
    router = build_router({"providers": [{"name": "e", "kind": "echo", "model": "echo"}]})
    assert router.budget.can_spend(1_000.0)


def test_default_config_will_not_spend_money():
    router = build_router(load_config())
    assert not router.budget.can_spend(0.01)
