#!/usr/bin/env python3
"""
Hybrid Router for the AI Workstation
- Routes model families to GPU / CPU+DRAM based on measured system resources
- Supports multiple model families (QWYTHOS, Muse Glimmer, GPT OSS)
- Falls back to CPU+DRAM when the GPU cannot hold the working set

Resource detection is delegated to jackierouter.system_profile, which probes
nvidia-smi, /proc/meminfo, sysctl or the Win32 memory API depending on the
platform. Anything it cannot measure is reported as unknown — this module does
not invent numbers, because a routing decision made from a fabricated 24 GB of
VRAM is worse than one made from an honest "unknown".
"""

import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

# The router package lives at the repository root, two levels up.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

try:
    from jackierouter.system_profile import probe as probe_system

    _PROBE_AVAILABLE = True
except ImportError:  # pragma: no cover - only when run outside the repo
    _PROBE_AVAILABLE = False

# Formats in descending order of quality; the first one present on disk wins.
FORMAT_PATTERNS = {
    "f16": ("f16", "fp16", "float16"),
    "q8": ("q8_0", "q8"),
    "q5km": ("q5_k_m", "q5km"),
    "q4km": ("q4_k_m", "q4km"),
}


class ModelConfig:
    """Configuration for a single AI model."""

    def __init__(
        self,
        name: str,
        paths: List[str],
        gpu_memory_mb: float,
        cpu_cores: int,
        recommended_gpu: str = "any",
        supported_formats: Optional[List[str]] = None,
    ):
        self.name = name
        self.paths = paths  # candidate GGUF paths, any quantisation
        self.gpu_memory_mb = gpu_memory_mb
        self.cpu_cores = cpu_cores
        self.recommended_gpu = recommended_gpu
        self.supported_formats = supported_formats or ["f16", "q4km"]

    def get_best_path(self) -> Optional[str]:
        """Return the highest-quality path that is actually on disk.

        Matching is case-insensitive and covers the real GGUF naming
        conventions (``Q4_K_M`` as well as ``q4km``), and the file has to exist
        — returning a path to a model that was never downloaded is how a
        "GPU route" turns into a crash three layers down.
        """
        for fmt in self.supported_formats:
            patterns = FORMAT_PATTERNS.get(fmt.lower(), (fmt.lower(),))
            for path in self.paths:
                lowered = path.lower()
                if not lowered.endswith(".gguf"):
                    continue
                if any(pattern in lowered for pattern in patterns) and os.path.exists(path):
                    return path

        # Nothing matched a preferred format; fall back to any file present.
        for path in self.paths:
            if os.path.exists(path):
                return path
        return None

    def fits_in(self, gpu_memory_gb: Optional[float]) -> Optional[bool]:
        """True/False if it can be decided, None when VRAM is unknown."""
        if gpu_memory_gb is None:
            return None
        return self.gpu_memory_mb / 1024.0 <= gpu_memory_gb


class HybridRouter:
    """
    Routes AI inference requests to the optimal compute resource.

    Architecture:
    - GPU: main brain (QWYTHOS, Muse Glimmer, Qwen2, SDXL, Flux)
    - CPU: multi-agent orchestration, pre/post-processing
    - DRAM: KV cache expansion, memory vaults, vector stores

    Route selection:
    1. GPU present, model fits in VRAM  -> GPU inference
    2. GPU present, model too large     -> GPU compute + DRAM KV cache offload
    3. No GPU, or VRAM unknown and small-> CPU+DRAM with multi-agent routing
    """

    def __init__(self, system_resources: Optional[Dict] = None):
        self.models: Dict[str, ModelConfig] = {}
        self.system_resources = system_resources or self._detect_system()

    def _detect_system(self) -> Dict:
        """Measure the machine. Unknown values stay None — never invented."""
        unknown = {
            "cpu_cores": os.cpu_count(),
            "cpu_model": "",
            "ram_total_mb": None,
            "ram_available_mb": None,
            "gpu_available": False,
            "gpu_name": "",
            "gpu_memory_gb": None,
            "gpu_free_memory_gb": None,
            "gpu_temperature_c": None,
            "detection": "unavailable",
        }
        if not _PROBE_AVAILABLE:
            return unknown

        try:
            profile = probe_system()
        except Exception:
            return unknown

        gpu = profile.gpus[0] if profile.gpus else None
        return {
            "cpu_cores": profile.cpu_cores_logical,
            "cpu_model": profile.cpu_model,
            "ram_total_mb": profile.ram_total_mb,
            "ram_available_mb": profile.ram_available_mb,
            "gpu_available": profile.has_gpu,
            "gpu_name": gpu.name if gpu else "",
            "gpu_memory_gb": (gpu.vram_total_mb / 1024.0) if gpu and gpu.vram_total_mb else None,
            "gpu_free_memory_gb": (
                (gpu.vram_free_mb / 1024.0) if gpu and gpu.vram_free_mb is not None else None
            ),
            "gpu_temperature_c": gpu.temperature_c if gpu else None,
            "detection": "measured",
        }

    def register_model(self, config: ModelConfig) -> None:
        self.models[config.name] = config

    def route_request(self, request: Dict) -> str:
        """
        Route an inference request to the optimal resource.

        Args:
            request: {'model_family': 'QWYTHOS'|'MUSE_GLIMMER'|'GPT_OSS',
                      'max_context': int, 'batch_size': int}

        Returns:
            A string describing the routing decision.
        """
        model_family = str(request.get("model_family", "")).upper()

        if model_family == "QWYTHOS":
            return self._route_family(request, "QWYTHOS_9B", "QWYTHOS-9B Claude Mythos 5")
        if model_family == "MUSE_GLIMMER":
            return self._route_family(request, "MUSE_GLIMMER_30B", "Muse-Glimmer-30B")
        return self._route_generic(request, model_family or "UNKNOWN")

    def _available_vram_gb(self) -> Optional[float]:
        """Prefer free VRAM over total — a card already holding a model is not empty."""
        free = self.system_resources.get("gpu_free_memory_gb")
        if free is not None:
            return free
        return self.system_resources.get("gpu_memory_gb")

    def _route_family(self, request: Dict, config_key: str, label: str) -> str:
        config = self.models.get(config_key)
        if not config:
            return f"ERROR: No {config_key} model configured"

        if not self.system_resources.get("gpu_available"):
            return f"CPU+DRAM: {label} fallback mode (no GPU detected)"

        vram_gb = self._available_vram_gb()
        # Working set is the weights plus roughly 2 GB per concurrent request.
        needed_gb = config.gpu_memory_mb / 1024.0 + 2.0 * int(request.get("batch_size", 1) or 1)

        if vram_gb is None:
            return f"GPU: {label} (VRAM unknown — monitor for OOM)"
        if needed_gb <= vram_gb:
            path = config.get_best_path()
            suffix = f" [{os.path.basename(path)}]" if path else " [weights not found on disk]"
            return f"GPU: {label} ({needed_gb:.1f}/{vram_gb:.1f} GB){suffix}"
        return (
            f"GPU+DRAM: {label} hybrid mode with KV cache offload "
            f"(needs {needed_gb:.1f} GB, {vram_gb:.1f} GB free)"
        )

    def _route_generic(self, request: Dict, model_family: str) -> str:
        if self.system_resources.get("gpu_available"):
            return f"GPU: {model_family} (primary inference)"
        return f"CPU+DRAM: {model_family} fallback mode"

    def describe_system(self) -> str:
        resources = self.system_resources
        ram = resources.get("ram_total_mb")
        vram = resources.get("gpu_memory_gb")
        return (
            f"cpu={resources.get('cpu_cores') or '?'} cores, "
            f"ram={f'{ram / 1024:.1f} GB' if ram else 'unknown'}, "
            f"gpu={resources.get('gpu_name') or 'none'}, "
            f"vram={f'{vram:.1f} GB' if vram else 'unknown'} "
            f"({resources.get('detection')})"
        )


def main() -> None:
    """Demonstrate hybrid routing against the machine this runs on."""
    router = HybridRouter()
    print("Detected system:", router.describe_system())
    print()

    router.register_model(
        ModelConfig(
            name="QWYTHOS_9B",
            paths=[
                r"E:\AI_Permanent\Models\QWYTHOS-9B\qwythos-9b-f16.gguf",
                r"E:\AI_Permanent\Models\QWYTHOS-9B\qwythos-9b-Q4_K_M.gguf",
            ],
            gpu_memory_mb=18_000,
            cpu_cores=16,
            recommended_gpu="RTX 3090",
        )
    )
    router.register_model(
        ModelConfig(
            name="MUSE_GLIMMER_30B",
            paths=[
                r"E:\AI_Permanent\Models\Muse-Glimmer-30B\muse-glimmer-30b-Q4_K_M.gguf",
            ],
            gpu_memory_mb=20_000,
            cpu_cores=16,
            supported_formats=["q4km"],
        )
    )

    for request in (
        {"model_family": "QWYTHOS", "max_context": 1_000_000, "batch_size": 1},
        {"model_family": "MUSE_GLIMMER", "max_context": 32_768, "batch_size": 2},
        {"model_family": "GPT_OSS", "max_context": 8_192, "batch_size": 1},
    ):
        print(f"{request['model_family']:14} -> {router.route_request(request)}")


if __name__ == "__main__":
    main()
