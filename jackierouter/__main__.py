"""Command line: ``python -m jackierouter <command>``.

    detect    what this machine actually is
    suggest   a provider ladder built from what was detected
    status    live quota, spend, and hardware for the configured ladder
    ask       send a prompt through the ladder and show the route it took
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional

from .anthropic_adapter import PRICING_PER_1K
from .config import load_config, router_from_env
from .errors import NoProviderAvailable
from .system_profile import SystemProfile, probe
from .types import RouteRequest

# Gate local inference a little below the thermal-throttle point rather than at
# it, so work moves off the box before the clocks drop rather than after.
DEFAULT_TEMP_GATE_C = 75.0
VRAM_HEADROOM_MB = 1024


def _human(profile: SystemProfile) -> str:
    lines = [
        f"host          {profile.hostname}",
        f"os            {profile.os_name} {profile.os_release} ({profile.arch})",
        f"python        {profile.python_version}",
        f"cpu           {profile.cpu_model or 'unknown'}",
        f"              {profile.cpu_cores_logical or '?'} logical / "
        f"{profile.cpu_cores_physical or '?'} physical cores",
    ]

    if profile.ram_total_mb:
        lines.append(
            f"ram           {profile.ram_total_mb / 1024:.1f} GB total, "
            f"{(profile.ram_available_mb or 0) / 1024:.1f} GB available"
        )
    else:
        lines.append("ram           unknown")

    lines.append(f"accelerator   {profile.accelerator}")
    if profile.gpus:
        for gpu in profile.gpus:
            vram = (
                f"{gpu.vram_total_mb / 1024:.1f} GB"
                if gpu.vram_total_mb
                else "unknown VRAM"
            )
            free = f", {gpu.vram_free_mb / 1024:.1f} GB free" if gpu.vram_free_mb else ""
            temp = f", {gpu.temperature_c:.0f}C" if gpu.temperature_c is not None else ""
            lines.append(f"  gpu {gpu.index}       {gpu.name} ({vram}{free}{temp})")
    else:
        lines.append("  gpu         none detected")

    npu = profile.npu
    lines.append(
        "npu           " + (", ".join(npu.get("details", [])) if npu.get("detected") else "none detected")
    )

    if profile.ollama_reachable:
        names = [m.get("name", "") for m in profile.ollama_models]
        lines.append(f"ollama        reachable, {len(names)} model(s)")
        for name in names:
            lines.append(f"  - {name}")
    else:
        lines.append("ollama        not reachable")

    return "\n".join(lines)


def suggest_config(profile: SystemProfile) -> Dict[str, Any]:
    """Build a ladder from what is actually installed on this machine.

    Tier 0 is every model Ollama really has, gated on the hardware really
    present. The cloud rungs are included but disabled, so nothing reaches the
    network until the user adds a key and flips ``enabled``.
    """
    providers: List[Dict[str, Any]] = []

    requires: Dict[str, Any] = {"require_ollama_model": True}
    if profile.has_gpu:
        requires["require_gpu"] = True
        requires["max_gpu_temp_c"] = DEFAULT_TEMP_GATE_C
        if profile.free_vram_mb:
            requires["min_free_vram_mb"] = max(512, int(profile.free_vram_mb * 0.25))

    for model in profile.ollama_models:
        name = model.get("name", "")
        if not name:
            continue
        size_mb = model.get("size_mb")
        provider_requires = dict(requires)
        if size_mb and profile.has_gpu:
            # A model cannot run on a card that cannot hold it.
            provider_requires["min_free_vram_mb"] = int(size_mb) + VRAM_HEADROOM_MB
        providers.append(
            {
                "name": f"local/{name.split(':')[0]}",
                "kind": "ollama",
                "model": name,
                "base_url": "http://localhost:11434",
                "tier": 0,
                "max_context": 32768,
                "capabilities": ["chat", "code"],
                "requires": provider_requires,
            }
        )

    if not providers:
        providers.append(
            {
                "name": "local/ollama",
                "kind": "ollama",
                "model": "qwen3.5:latest",
                "base_url": "http://localhost:11434",
                "tier": 0,
                "max_context": 32768,
                "capabilities": ["chat"],
                "requires": {"require_ollama_model": True},
                "_comment": "No Ollama model detected — pull one, then re-run suggest.",
            }
        )

    providers.append(
        {
            "name": "anthropic/opus-5",
            "kind": "anthropic",
            "model": "claude-opus-5",
            "api_key_env": "ANTHROPIC_API_KEY",
            "tier": 2,
            "max_context": 200000,
            "capabilities": ["chat", "code", "long-context"],
            "cost_per_1k_input": PRICING_PER_1K["claude-opus-5"][0],
            "cost_per_1k_output": PRICING_PER_1K["claude-opus-5"][1],
            "enabled": False,
            "_comment": "Set ANTHROPIC_API_KEY and enabled=true to allow cloud failover.",
        }
    )

    return {
        "horizon_seconds": 30,
        "risk_policy": "migrate",
        "budget": {"per_hour": 0.0, "per_day": 0.0},
        "state_path": "jackierouter-state.json",
        "system_probe": {"enabled": True, "ttl_seconds": 30},
        "providers": providers,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="jackierouter", description=__doc__)
    subcommands = parser.add_subparsers(dest="command")

    detect = subcommands.add_parser("detect", help="show what this machine is")
    detect.add_argument("--json", action="store_true", help="machine-readable output")

    suggest = subcommands.add_parser("suggest", help="write a config for this machine")
    suggest.add_argument("-o", "--out", help="write to this path instead of stdout")

    status = subcommands.add_parser("status", help="live quota, spend and hardware")
    status.add_argument("-c", "--config", help="config path (default: $JACKIEROUTER_CONFIG)")

    ask = subcommands.add_parser("ask", help="send one prompt through the ladder")
    ask.add_argument("prompt")
    ask.add_argument("-c", "--config", help="config path (default: $JACKIEROUTER_CONFIG)")
    ask.add_argument("--capability", help="e.g. code, chat, long-context")
    ask.add_argument("--stream", action="store_true", help="stream the response")

    args = parser.parse_args(argv)

    if args.command == "detect":
        profile = probe()
        print(json.dumps(profile.to_dict(), indent=2) if args.json else _human(profile))
        return 0

    if args.command == "suggest":
        config = json.dumps(suggest_config(probe()), indent=2)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(config + "\n")
            print(f"wrote {args.out}")
        else:
            print(config)
        return 0

    if args.command == "status":
        print(json.dumps(router_from_env(args.config).status(), indent=2))
        return 0

    if args.command == "ask":
        router = router_from_env(args.config)
        request = RouteRequest(
            messages=[{"role": "user", "content": args.prompt}],
            capability=args.capability,
        )
        try:
            if args.stream:
                stream = router.stream(request)
                for chunk in stream:
                    sys.stdout.write(chunk)
                    sys.stdout.flush()
                print()
                result = stream.result
            else:
                result = router.dispatch(request)
                print(result.text)
        except NoProviderAvailable as exc:
            print(f"error: {exc}", file=sys.stderr)
            for attempt in exc.trace:
                print(f"  {attempt.provider}: {attempt.outcome} — {attempt.detail}", file=sys.stderr)
            return 1

        print(
            f"\n[{result.provider} / {result.model}] "
            f"${result.cost:.4f}, {result.handoffs} handoff(s)",
            file=sys.stderr,
        )
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
