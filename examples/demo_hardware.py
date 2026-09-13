#!/usr/bin/env python3
"""The router recognising the machine — and routing around it.

Run it to see what this box actually is, then watch the same ladder make four
different decisions as the hardware changes underneath it. No API keys, no GPU
required: the hardware profiles below are stated explicitly so the behaviour is
visible on any machine.

    python examples/demo_hardware.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jackierouter import (  # noqa: E402
    EchoAdapter,
    HardwareRequirements,
    Provider,
    RouteRequest,
    Router,
    SystemProbe,
    probe,
)
from jackierouter.__main__ import _human  # noqa: E402
from jackierouter.system_profile import GPU, SystemProfile  # noqa: E402


def workstation(**overrides) -> SystemProfile:
    base = dict(
        hostname="tower",
        ram_total_mb=131072,
        ram_available_mb=96000,
        gpus=[
            GPU(index=0, name="RTX 3090", vram_total_mb=24576, vram_used_mb=2048,
                temperature_c=47)
        ],
        accelerator="nvidia",
        ollama_reachable=True,
        ollama_models=[{"name": "gemma4:26b"}],
    )
    base.update(overrides)
    return SystemProfile(**base)


SCENARIOS = [
    ("box is cool and idle", workstation()),
    (
        "box is thermal-throttling at 84C",
        workstation(
            gpus=[GPU(index=0, name="RTX 3090", vram_total_mb=24576, vram_used_mb=2048,
                      temperature_c=84)]
        ),
    ),
    (
        "another model already holds the card",
        workstation(
            gpus=[GPU(index=0, name="RTX 3090", vram_total_mb=24576, vram_used_mb=23000,
                      temperature_c=50)]
        ),
    ),
    ("box is asleep (ollama not answering)", workstation(ollama_reachable=False, ollama_models=[])),
]


def main() -> None:
    print("What this machine actually is:\n")
    print(_human(probe()))
    print("\n" + "=" * 68 + "\n")
    print("The same two-rung ladder, four different machines:\n")

    for label, profile in SCENARIOS:
        router = Router(
            [
                Provider(
                    name="local/gemma",
                    model="gemma4:26b",
                    adapter=EchoAdapter(reply="answered locally, free"),
                    tier=0,
                    requires=HardwareRequirements(
                        require_gpu=True,
                        require_ollama_model=True,
                        min_free_vram_mb=17000,
                        max_gpu_temp_c=75,
                    ),
                ),
                Provider(
                    name="anthropic/opus-5",
                    model="claude-opus-5",
                    adapter=EchoAdapter(reply="answered in the cloud"),
                    tier=2,
                    cost_per_1k_input=0.005,
                    cost_per_1k_output=0.025,
                ),
            ],
            system_probe=SystemProbe(probe_fn=lambda p=profile: p),
        )

        result = router.dispatch(
            RouteRequest(messages=[{"role": "user", "content": "refactor this"}])
        )
        skipped = next((a for a in result.trace if a.outcome == "skipped"), None)
        print(f"  {label:38} -> {result.provider}")
        if skipped:
            print(f"  {'':38}    (local skipped: {skipped.detail})")

    print("\nNothing here is a timeout. Each skip was decided before the call.")


if __name__ == "__main__":
    main()
