#!/usr/bin/env python3
"""
Router test suite — exercises the real HybridRouter.

The previous version of this file defined a MockHybridRouter inside itself and
tested that, so it reported "ALL TESTS PASSED" no matter what hybrid_router.py
did (its checks were `time.sleep(0.1); return True`). These tests import the
real class and inject a fixed system profile, so the routing decisions are
deterministic *and* a regression in hybrid_router.py actually fails the run.

Run directly (`python test_router_suite.py`) or under pytest.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hybrid_router import HybridRouter, ModelConfig  # noqa: E402

WORKSTATION = {
    "cpu_cores": 32,
    "cpu_model": "AMD Ryzen 9",
    "ram_total_mb": 131_072,
    "ram_available_mb": 96_000,
    "gpu_available": True,
    "gpu_name": "NVIDIA GeForce RTX 3090",
    "gpu_memory_gb": 24.0,
    "gpu_free_memory_gb": 24.0,
    "gpu_temperature_c": 47.0,
    "detection": "measured",
}

LAPTOP = dict(WORKSTATION, gpu_available=False, gpu_name="", gpu_memory_gb=None,
              gpu_free_memory_gb=None, gpu_temperature_c=None)

BUSY_GPU = dict(WORKSTATION, gpu_free_memory_gb=4.0)


def _router(resources, models=("QWYTHOS_9B", "MUSE_GLIMMER_30B")):
    router = HybridRouter(system_resources=dict(resources))
    sizes = {"QWYTHOS_9B": 18_000, "MUSE_GLIMMER_30B": 20_000}
    for name in models:
        router.register_model(
            ModelConfig(name=name, paths=[], gpu_memory_mb=sizes[name], cpu_cores=16)
        )
    return router


# -- routing decisions -----------------------------------------------------


def test_gpu_route_when_the_model_fits():
    result = _router(WORKSTATION).route_request({"model_family": "QWYTHOS", "batch_size": 1})
    assert result.startswith("GPU:"), result


def test_offloads_to_dram_when_the_model_does_not_fit():
    # 20 GB of weights + 2 GB x 3 concurrent requests exceeds a 24 GB card.
    result = _router(WORKSTATION).route_request(
        {"model_family": "MUSE_GLIMMER", "batch_size": 3}
    )
    assert result.startswith("GPU+DRAM:"), result
    assert "KV cache offload" in result


def test_busy_card_is_treated_as_busy_not_empty():
    """Free VRAM, not total VRAM, decides — a card already holding a model
    cannot hold another."""
    result = _router(BUSY_GPU).route_request({"model_family": "QWYTHOS", "batch_size": 1})
    assert result.startswith("GPU+DRAM:"), result


def test_cpu_fallback_without_a_gpu():
    result = _router(LAPTOP).route_request({"model_family": "QWYTHOS", "batch_size": 1})
    assert result.startswith("CPU+DRAM:"), result
    assert "no GPU detected" in result


def test_unknown_vram_is_not_treated_as_infinite():
    resources = dict(WORKSTATION, gpu_memory_gb=None, gpu_free_memory_gb=None)
    result = _router(resources).route_request({"model_family": "QWYTHOS", "batch_size": 1})
    assert "VRAM unknown" in result, result


def test_unregistered_model_is_an_explicit_error():
    router = HybridRouter(system_resources=dict(WORKSTATION))
    assert router.route_request({"model_family": "QWYTHOS"}).startswith("ERROR:")


def test_unknown_family_still_routes():
    assert _router(WORKSTATION).route_request({"model_family": "GPT_OSS"}).startswith("GPU:")
    assert _router(LAPTOP).route_request({"model_family": "GPT_OSS"}).startswith("CPU+DRAM:")


# -- model path selection --------------------------------------------------


def test_best_path_prefers_f16_and_requires_the_file_to_exist():
    with tempfile.TemporaryDirectory() as directory:
        f16 = os.path.join(directory, "model-f16.gguf")
        q4 = os.path.join(directory, "model-Q4_K_M.gguf")
        Path(q4).write_text("weights")

        config = ModelConfig("m", [f16, q4], gpu_memory_mb=1000, cpu_cores=4)
        # f16 is preferred but absent, so the real file on disk wins.
        assert config.get_best_path() == q4

        Path(f16).write_text("weights")
        assert config.get_best_path() == f16


def test_best_path_matches_real_gguf_naming():
    """`Q4_K_M` is how the files are actually named; `q4km` is the config spelling."""
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "QWYTHOS-9B-Q4_K_M.gguf")
        Path(path).write_text("weights")
        config = ModelConfig("m", [path], gpu_memory_mb=1, cpu_cores=1, supported_formats=["q4km"])
        assert config.get_best_path() == path


def test_best_path_is_none_when_nothing_is_downloaded():
    config = ModelConfig("m", ["/nonexistent/model-f16.gguf"], gpu_memory_mb=1, cpu_cores=1)
    assert config.get_best_path() is None


# -- detection honesty -----------------------------------------------------


def test_detection_reports_unknowns_rather_than_inventing_them():
    """A probe failure must not produce a fabricated 24 GB GPU."""
    router = HybridRouter.__new__(HybridRouter)
    router.models = {}
    import hybrid_router

    original = hybrid_router._PROBE_AVAILABLE
    hybrid_router._PROBE_AVAILABLE = False
    try:
        resources = router._detect_system()
    finally:
        hybrid_router._PROBE_AVAILABLE = original

    assert resources["gpu_available"] is False
    assert resources["gpu_memory_gb"] is None
    assert resources["ram_total_mb"] is None
    assert resources["detection"] == "unavailable"


def test_fits_in_returns_none_when_vram_is_unknown():
    config = ModelConfig("m", [], gpu_memory_mb=8000, cpu_cores=4)
    assert config.fits_in(24.0) is True
    assert config.fits_in(4.0) is False
    assert config.fits_in(None) is None


def run_router_tests() -> bool:
    """Run every check in this module and print a report."""
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]

    print("=" * 70)
    print("HYBRID ROUTER TEST SUITE")
    print("=" * 70)
    print()

    failures = 0
    for test in tests:
        try:
            test()
        except AssertionError as exc:
            failures += 1
            print(f"  [FAIL] {test.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001 - a crash is a failure too
            failures += 1
            print(f"  [ERROR] {test.__name__}: {exc!r}")
        else:
            print(f"  [PASS] {test.__name__}")

    print()
    print("=" * 70)
    print(f"Total: {len(tests)}   Passed: {len(tests) - failures}   Failed: {failures}")
    print("=" * 70)
    return failures == 0


if __name__ == "__main__":
    sys.exit(0 if run_router_tests() else 1)
