"""Routing decisions made from what the machine actually is."""

import pytest

from jackierouter import (
    EchoAdapter,
    NoProviderAvailable,
    Provider,
    RouteRequest,
    Router,
)
from jackierouter.system_profile import GPU, SystemProbe, SystemProfile
from jackierouter.types import HardwareRequirements

WORKSTATION = SystemProfile(
    hostname="workstation",
    ram_total_mb=131072,
    ram_available_mb=96000,
    gpus=[GPU(index=0, name="RTX 3090", vram_total_mb=24576, vram_used_mb=2048, temperature_c=47)],
    accelerator="nvidia",
    ollama_reachable=True,
    ollama_models=[{"name": "qwen3.5:latest"}],
)


def profile_with(**overrides) -> SystemProfile:
    base = SystemProfile(**{**WORKSTATION.__dict__, **overrides})
    return base


def probe_of(profile) -> SystemProbe:
    return SystemProbe(probe_fn=lambda: profile)


def router_for(profile, requires, model="qwen3.5:latest"):
    local = Provider(
        name="local", model=model, adapter=EchoAdapter(reply="local"), tier=0, requires=requires
    )
    cloud = Provider(
        name="cloud", model="cloud-1", adapter=EchoAdapter(reply="cloud"), tier=2,
        cost_per_1k_input=0.005,
    )
    return Router([local, cloud], system_probe=probe_of(profile))


def ask():
    return RouteRequest(messages=[{"role": "user", "content": "hi"}])


def test_healthy_box_keeps_the_work_local():
    router = router_for(WORKSTATION, HardwareRequirements(require_gpu=True, max_gpu_temp_c=75))
    assert router.dispatch(ask()).provider == "local"


def test_a_hot_gpu_sends_the_work_to_the_cloud():
    """Thermal gating: move off the box before the clocks drop, not after."""
    hot = profile_with(
        gpus=[GPU(index=0, name="RTX 3090", vram_total_mb=24576, vram_used_mb=2048,
                  temperature_c=84)]
    )
    router = router_for(hot, HardwareRequirements(require_gpu=True, max_gpu_temp_c=75))
    result = router.dispatch(ask())
    assert result.provider == "cloud"
    assert any("84C" in a.detail for a in result.trace)


def test_a_full_card_sends_the_work_to_the_cloud():
    busy = profile_with(
        gpus=[GPU(index=0, name="RTX 3090", vram_total_mb=24576, vram_used_mb=23000)]
    )
    router = router_for(busy, HardwareRequirements(min_free_vram_mb=8000))
    result = router.dispatch(ask())
    assert result.provider == "cloud"
    assert any("VRAM free" in a.detail for a in result.trace)


def test_a_model_that_was_never_pulled_is_skipped():
    router = router_for(
        WORKSTATION, HardwareRequirements(require_ollama_model=True), model="gemma4:26b"
    )
    result = router.dispatch(ask())
    assert result.provider == "cloud"
    assert any("not pulled" in a.detail for a in result.trace)


def test_a_sleeping_box_is_skipped_before_the_call_not_after_the_timeout():
    asleep = profile_with(ollama_reachable=False, ollama_models=[])
    router = router_for(asleep, HardwareRequirements(require_ollama=True))
    result = router.dispatch(ask())
    assert result.provider == "cloud"
    assert any("ollama is not reachable" in a.detail for a in result.trace)


def test_no_gpu_at_all_is_a_clear_reason():
    laptop = profile_with(gpus=[], accelerator="cpu")
    router = router_for(laptop, HardwareRequirements(require_gpu=True))
    assert router.dispatch(ask()).provider == "cloud"


def test_an_unmeasurable_sensor_never_blocks_routing():
    """A missing reading is not a failed check — refusing to route because a
    sensor is absent would be worse than routing."""
    no_sensors = profile_with(
        gpus=[GPU(index=0, name="Some GPU", vram_total_mb=None, vram_used_mb=None,
                  temperature_c=None)]
    )
    router = router_for(
        no_sensors,
        HardwareRequirements(require_gpu=True, max_gpu_temp_c=75, min_free_vram_mb=8000),
    )
    assert router.dispatch(ask()).provider == "local"


def test_a_broken_probe_does_not_block_routing():
    class Exploding:
        def profile(self):
            raise RuntimeError("nvidia-smi segfaulted")

    router = Router(
        [Provider(name="local", model="m", adapter=EchoAdapter(), tier=0,
                  requires=HardwareRequirements(require_gpu=True))],
        system_probe=Exploding(),
    )
    assert router.dispatch(ask()).provider == "local"


def test_no_probe_is_built_for_a_ladder_with_no_hardware_needs():
    router = Router([Provider(name="cloud", model="m", adapter=EchoAdapter(), tier=1)])
    assert router.system_probe is None  # a cloud-only ladder never shells out


def test_status_reports_the_machine_and_the_blocker():
    hot = profile_with(
        gpus=[GPU(index=0, name="RTX 3090", vram_total_mb=24576, vram_used_mb=0,
                  temperature_c=90)]
    )
    router = router_for(hot, HardwareRequirements(max_gpu_temp_c=75))
    status = router.status()
    assert status["system"]["accelerator"] == "nvidia"
    assert status["system"]["gpus"][0]["temperature_c"] == 90
    local = next(p for p in status["providers"] if p["name"] == "local")
    assert "gated above" in local["hardware_blocker"]


def test_hardware_blocks_everything_and_the_error_says_why():
    laptop = profile_with(gpus=[], accelerator="cpu")
    router = Router(
        [Provider(name="local", model="m", adapter=EchoAdapter(), tier=0,
                  requires=HardwareRequirements(require_gpu=True))],
        system_probe=probe_of(laptop),
    )
    with pytest.raises(NoProviderAvailable) as excinfo:
        router.dispatch(ask())
    assert "no GPU detected" in excinfo.value.trace[0].detail
