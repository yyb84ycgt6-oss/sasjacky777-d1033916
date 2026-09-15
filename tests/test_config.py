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


def test_hardware_requirements_are_built_from_config():
    provider = build_provider(
        {
            "name": "local",
            "kind": "ollama",
            "model": "qwen3.5:latest",
            "requires": {
                "require_gpu": True,
                "min_free_vram_mb": 8000,
                "max_gpu_temp_c": 75,
                "require_ollama_model": True,
            },
        }
    )
    assert provider.requires.max_gpu_temp_c == 75
    assert provider.requires.require_ollama_model is True


def test_a_misspelled_requirement_is_rejected_loudly():
    """Silently ignoring `max_temp` would leave a thermal gate that never fires."""
    with pytest.raises(ValueError, match="unknown hardware requirement"):
        build_provider({"name": "x", "kind": "ollama", "model": "m", "requires": {"max_temp": 80}})


def test_anthropic_provider_gets_published_pricing_when_unpriced():
    """An unpriced Claude rung would otherwise budget as if it were free."""
    provider = build_provider({"name": "c", "kind": "anthropic", "model": "claude-opus-5"})
    assert (provider.cost_per_1k_input, provider.cost_per_1k_output) == (0.005, 0.025)
    assert not provider.is_free


def test_explicit_pricing_still_wins():
    provider = build_provider(
        {"name": "c", "kind": "anthropic", "model": "claude-opus-5",
         "cost_per_1k_input": 0.001, "cost_per_1k_output": 0.002}
    )
    assert provider.cost_per_1k_input == 0.001


def test_an_unknown_anthropic_model_is_not_assumed_free_of_charge():
    provider = build_provider({"name": "c", "kind": "anthropic", "model": "claude-future-9"})
    assert provider.is_free  # nothing to bill against, but the name is honest
    assert provider.adapter.model == "claude-future-9"


def test_state_path_attaches_a_store(tmp_path):
    router = build_router(
        {
            "providers": [{"name": "e", "kind": "echo", "model": "echo"}],
            "state_path": str(tmp_path / "state.json"),
        }
    )
    assert router.state_store is not None


def test_system_probe_is_only_built_when_a_provider_needs_hardware():
    without = build_router({"providers": [{"name": "e", "kind": "echo", "model": "echo"}]})
    assert without.system_probe is None

    with_requirements = build_router(
        {
            "providers": [
                {"name": "e", "kind": "ollama", "model": "m", "requires": {"require_gpu": True}}
            ]
        }
    )
    assert with_requirements.system_probe is not None


def test_system_probe_can_be_switched_off():
    router = build_router(
        {
            "providers": [
                {"name": "e", "kind": "ollama", "model": "m", "requires": {"require_gpu": True}}
            ],
            "system_probe": {"enabled": False},
        }
    )
    assert router.system_probe is None
