"""Declarative configuration.

A router whose ladder is hard-coded is a router nobody else can use. Providers,
limits, tiers, prices, and caps all come from one JSON document so that adding
a provider is an edit, not a deploy.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

from .adapters import EchoAdapter, OllamaAdapter, OpenAICompatAdapter
from .budget_guardian import BudgetGuardian, SpendWindow
from .router import CONSERVE, MIGRATE, Router
from .types import Limit, Provider

CONFIG_ENV = "JACKIEROUTER_CONFIG"

DEFAULT_CONFIG: Dict[str, Any] = {
    "horizon_seconds": 30,
    "risk_policy": MIGRATE,
    "budget": {"per_hour": 0.0, "per_day": 0.0},
    "providers": [
        {
            "name": "local/qwen",
            "kind": "ollama",
            "model": "qwen3.5:latest",
            "base_url": "http://localhost:11434",
            "tier": 0,
            "max_context": 32768,
            "capabilities": ["chat"],
        },
        {
            "name": "local/gemma-code",
            "kind": "ollama",
            "model": "gemma4:26b",
            "base_url": "http://localhost:11434",
            "tier": 0,
            "max_context": 32768,
            "capabilities": ["code", "chat"],
        },
    ],
}


def build_adapter(spec: Dict[str, Any]):
    kind = (spec.get("kind") or "ollama").lower()
    model = spec["model"]
    name = spec.get("name", model)

    if kind == "ollama":
        return OllamaAdapter(
            model=model,
            base_url=spec.get("base_url", "http://localhost:11434"),
            timeout=spec.get("timeout", 120.0),
            name=name,
        )
    if kind in ("openai", "openai-compatible", "openai_compat"):
        return OpenAICompatAdapter(
            model=model,
            base_url=spec["base_url"],
            api_key_env=spec.get("api_key_env"),
            timeout=spec.get("timeout", 120.0),
            name=name,
        )
    if kind == "echo":
        return EchoAdapter(reply=spec.get("reply", "ok"), name=name)
    raise ValueError(f"unknown provider kind: {kind!r}")


def build_provider(spec: Dict[str, Any]) -> Provider:
    limits = [
        Limit(
            window_seconds=float(limit["window_seconds"]),
            requests=limit.get("requests"),
            tokens=limit.get("tokens"),
            label=limit.get("label", ""),
        )
        for limit in spec.get("limits", [])
    ]
    return Provider(
        name=spec.get("name", spec["model"]),
        model=spec["model"],
        adapter=build_adapter(spec),
        tier=int(spec.get("tier", 0)),
        cost_per_1k_input=float(spec.get("cost_per_1k_input", 0.0)),
        cost_per_1k_output=float(spec.get("cost_per_1k_output", 0.0)),
        limits=limits,
        capabilities=frozenset(spec.get("capabilities", [])),
        max_context=int(spec.get("max_context", 8192)),
        enabled=bool(spec.get("enabled", True)),
    )


def build_budget(spec: Optional[Dict[str, Any]]) -> BudgetGuardian:
    spec = spec or {}
    windows: List[SpendWindow] = []
    # 0 means "spend nothing", not "no cap" — a router configured to stay
    # local must not be one typo away from a bill. Omit the key for no cap.
    if spec.get("per_hour") is not None:
        windows.append(SpendWindow(3600.0, float(spec["per_hour"]), label="hourly"))
    if spec.get("per_day") is not None:
        windows.append(SpendWindow(86400.0, float(spec["per_day"]), label="daily"))
    for extra in spec.get("windows", []):
        windows.append(
            SpendWindow(
                float(extra["seconds"]), float(extra["cap"]), label=extra.get("label", "")
            )
        )
    return BudgetGuardian(windows)


def build_router(config: Dict[str, Any]) -> Router:
    providers = [build_provider(spec) for spec in config.get("providers", [])]
    if not providers:
        raise ValueError("configuration declares no providers")
    policy = config.get("risk_policy", MIGRATE)
    if policy not in (MIGRATE, CONSERVE):
        raise ValueError(f"unknown risk_policy: {policy!r}")
    return Router(
        providers,
        budget=build_budget(config.get("budget")),
        horizon_seconds=float(config.get("horizon_seconds", 30.0)),
        risk_policy=policy,
        briefing_max_chars=int(config.get("briefing_max_chars", 2000)),
    )


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    """Read config from an explicit path, then ``$JACKIEROUTER_CONFIG``, then the default."""
    path = path or os.environ.get(CONFIG_ENV)
    if not path:
        return json.loads(json.dumps(DEFAULT_CONFIG))  # a private copy
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def router_from_env(path: Optional[str] = None) -> Router:
    return build_router(load_config(path))
