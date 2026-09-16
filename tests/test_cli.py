"""The `python -m jackierouter` commands."""

import json

import pytest

from jackierouter.__main__ import main, suggest_config
from jackierouter.config import build_router
from jackierouter.system_profile import GPU, SystemProfile

WORKSTATION = SystemProfile(
    hostname="tower",
    os_name="Windows",
    os_release="11",
    arch="AMD64",
    cpu_cores_logical=32,
    ram_total_mb=131072,
    ram_available_mb=96000,
    gpus=[GPU(index=0, name="RTX 3090", vram_total_mb=24576, vram_used_mb=2048, temperature_c=47)],
    accelerator="nvidia",
    ollama_reachable=True,
    ollama_models=[
        {"name": "qwen3.5:latest", "size_mb": 5000},
        {"name": "gemma4:26b", "size_mb": 16000},
    ],
)


def test_suggest_builds_a_ladder_from_installed_models():
    config = suggest_config(WORKSTATION)
    names = [p["name"] for p in config["providers"]]
    assert "local/qwen3.5" in names
    assert "local/gemma4" in names


def test_suggested_config_actually_builds_a_router():
    """A suggestion that cannot be loaded is not a suggestion."""
    router = build_router(suggest_config(WORKSTATION))
    assert [p.name for p in router.providers][:2] == ["local/qwen3.5", "local/gemma4"]


def test_suggestion_sizes_the_vram_gate_to_each_model():
    config = suggest_config(WORKSTATION)
    gemma = next(p for p in config["providers"] if p["name"] == "local/gemma4")
    qwen = next(p for p in config["providers"] if p["name"] == "local/qwen3.5")
    # A 16GB model needs more free VRAM than a 5GB one.
    assert gemma["requires"]["min_free_vram_mb"] > qwen["requires"]["min_free_vram_mb"]
    assert gemma["requires"]["max_gpu_temp_c"] == 75.0


def test_suggestion_leaves_the_cloud_rung_disabled_and_unfunded():
    """Nothing reaches the network, and nothing spends, until the user says so."""
    config = suggest_config(WORKSTATION)
    cloud = next(p for p in config["providers"] if p["tier"] > 0)
    assert cloud["enabled"] is False
    assert config["budget"] == {"per_hour": 0.0, "per_day": 0.0}
    assert build_router(config).budget.can_spend(0.01) is False


def test_suggestion_without_a_gpu_omits_gpu_gates():
    laptop = SystemProfile(ollama_reachable=True, ollama_models=[{"name": "qwen3.5:latest"}])
    provider = suggest_config(laptop)["providers"][0]
    assert "require_gpu" not in provider["requires"]
    assert provider["requires"]["require_ollama_model"] is True


def test_suggestion_with_no_models_says_so():
    config = suggest_config(SystemProfile())
    assert "_comment" in config["providers"][0]
    build_router(config)  # still loadable


def test_detect_prints_something_readable(capsys):
    assert main(["detect"]) == 0
    out = capsys.readouterr().out
    assert "accelerator" in out and "ollama" in out


def test_detect_json_is_parseable(capsys):
    assert main(["detect", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert "gpus" in payload and "cpu_cores_logical" in payload


def test_suggest_writes_a_file(tmp_path, capsys):
    out = tmp_path / "router.json"
    assert main(["suggest", "-o", str(out)]) == 0
    build_router(json.loads(out.read_text()))


def test_status_reports_the_configured_ladder(tmp_path, capsys, monkeypatch):
    config = tmp_path / "c.json"
    config.write_text(json.dumps({"providers": [{"name": "e", "kind": "echo", "model": "echo"}]}))
    assert main(["status", "-c", str(config)]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["providers"][0]["name"] == "e"


def test_ask_routes_a_prompt(tmp_path, capsys):
    config = tmp_path / "c.json"
    config.write_text(
        json.dumps({"providers": [{"name": "e", "kind": "echo", "model": "echo", "reply": "hi"}]})
    )
    assert main(["ask", "hello", "-c", str(config)]) == 0
    captured = capsys.readouterr()
    assert "hi" in captured.out
    assert "[e / echo]" in captured.err


def test_ask_streams(tmp_path, capsys):
    config = tmp_path / "c.json"
    config.write_text(
        json.dumps(
            {"providers": [{"name": "e", "kind": "echo", "model": "echo", "reply": "a b c"}]}
        )
    )
    assert main(["ask", "hello", "-c", str(config), "--stream"]) == 0
    assert "a b c" in capsys.readouterr().out


def test_ask_explains_an_unroutable_request(tmp_path, capsys):
    config = tmp_path / "c.json"
    config.write_text(
        json.dumps(
            {"providers": [{"name": "e", "kind": "echo", "model": "echo", "enabled": False}]}
        )
    )
    assert main(["ask", "hello", "-c", str(config)]) == 1
    assert "disabled" in capsys.readouterr().err


def test_bare_invocation_shows_help(capsys):
    assert main([]) == 1
    assert "usage" in capsys.readouterr().out.lower()
