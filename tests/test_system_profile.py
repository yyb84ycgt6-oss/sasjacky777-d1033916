"""Hardware recognition. Probes are stubbed — no vendor tools needed to test."""

import json

import pytest

from jackierouter import system_profile as sp
from jackierouter.system_profile import GPU, SystemProbe, SystemProfile, probe


def test_probe_never_raises_on_this_machine():
    """Whatever this is running on, a profile comes back."""
    profile = probe()
    assert profile.hostname
    assert profile.os_name
    assert isinstance(profile.gpus, list)
    json.dumps(profile.to_dict())  # must stay serializable for /status and state


def test_nvidia_output_is_parsed(monkeypatch):
    monkeypatch.setattr(
        sp,
        "_run",
        lambda *a, **k: "0, NVIDIA GeForce RTX 3090, 24576, 8192, 71, 43",
    )
    gpus = sp.probe_nvidia()
    assert len(gpus) == 1
    gpu = gpus[0]
    assert gpu.name == "NVIDIA GeForce RTX 3090"
    assert gpu.vram_total_mb == 24576
    assert gpu.vram_free_mb == 16384
    assert gpu.temperature_c == 71
    assert gpu.vendor == "nvidia"


def test_missing_nvidia_smi_is_not_an_error(monkeypatch):
    monkeypatch.setattr(sp, "_run", lambda *a, **k: None)
    assert sp.probe_nvidia() == []


def test_unparseable_nvidia_fields_degrade_to_none(monkeypatch):
    monkeypatch.setattr(sp, "_run", lambda *a, **k: "0, Some GPU, [N/A], [N/A], [N/A], [N/A]")
    gpu = sp.probe_nvidia()[0]
    assert gpu.vram_total_mb is None
    assert gpu.vram_free_mb is None  # unknown, never guessed


def test_free_vram_uses_the_largest_single_card():
    """A model loads into one card, so two 8GB cards are not one 16GB card."""
    profile = SystemProfile(
        gpus=[
            GPU(index=0, name="a", vram_total_mb=8192, vram_used_mb=4096),
            GPU(index=1, name="b", vram_total_mb=8192, vram_used_mb=1024),
        ]
    )
    assert profile.free_vram_mb == 7168


def test_apple_silicon_reports_unified_memory_as_vram():
    profile = SystemProfile(accelerator="apple-silicon", ram_available_mb=32000)
    assert profile.free_vram_mb == 32000


def test_ollama_tags_are_read(monkeypatch):
    payload = {"models": [{"name": "qwen3.5:latest", "size": 5_000_000_000,
                           "details": {"family": "qwen"}}]}

    class FakeResponse:
        def read(self):
            return json.dumps(payload).encode()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(sp.urllib.request, "urlopen", lambda *a, **k: FakeResponse())
    result = sp.probe_ollama()
    assert result["reachable"] is True
    assert result["models"][0]["name"] == "qwen3.5:latest"


def test_unreachable_ollama_is_reported_not_raised(monkeypatch):
    def boom(*args, **kwargs):
        raise OSError("connection refused")

    monkeypatch.setattr(sp.urllib.request, "urlopen", boom)
    assert sp.probe_ollama() == {"reachable": False, "models": []}


@pytest.mark.parametrize(
    "installed,asked,expected",
    [
        ("qwen3.5:latest", "qwen3.5", True),      # bare name means :latest
        ("qwen3.5:latest", "qwen3.5:latest", True),
        ("qwen3.5:7b", "qwen3.5", False),         # :7b is not :latest
        ("qwen3.5:latest", "gemma4:26b", False),
    ],
)
def test_has_ollama_model_matches_tags(installed, asked, expected):
    profile = SystemProfile(ollama_models=[{"name": installed}])
    assert profile.has_ollama_model(asked) is expected


def test_probe_is_cached_until_the_ttl_expires():
    calls = {"n": 0}
    clock = {"t": 0.0}

    def fake_probe():
        calls["n"] += 1
        return SystemProfile(hostname="x", probed_at=clock["t"])

    probe_obj = SystemProbe(ttl_seconds=30.0, time_fn=lambda: clock["t"], probe_fn=fake_probe)
    probe_obj.profile()
    probe_obj.profile()
    assert calls["n"] == 1  # routing must not shell out per request

    clock["t"] = 31.0
    probe_obj.profile()
    assert calls["n"] == 2

    probe_obj.refresh()
    assert calls["n"] == 3
