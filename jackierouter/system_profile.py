"""Hardware recognition.

A router that does not know what machine it is on cannot honestly claim to
prefer local inference. "Tier 0 is your own hardware" is only true if something
checks that the hardware is awake, cool, and has the VRAM free — otherwise the
router is just hoping, and the user pays for the hope in latency when the box
is thermal-throttling or the model was never pulled.

Everything here is standard library and best-effort: every probe degrades to
"unknown" rather than raising, because a router must still route on a machine
whose vendor tools are missing. Nothing is guessed — a field is either measured
or reported as ``None``.
"""

from __future__ import annotations

import ctypes
import json
import os
import platform
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

PROBE_TIMEOUT = 5.0


def _run(command: List[str], timeout: float = PROBE_TIMEOUT) -> Optional[str]:
    """Run a probe command, returning None for any failure at all."""
    if not shutil.which(command[0]):
        return None
    try:
        out = subprocess.check_output(
            command, stderr=subprocess.DEVNULL, text=True, timeout=timeout
        )
        return out.strip() or None
    except Exception:
        return None


@dataclass
class GPU:
    index: int
    name: str
    vram_total_mb: Optional[int] = None
    vram_used_mb: Optional[int] = None
    temperature_c: Optional[float] = None
    utilization_pct: Optional[float] = None
    vendor: str = "unknown"

    @property
    def vram_free_mb(self) -> Optional[int]:
        if self.vram_total_mb is None or self.vram_used_mb is None:
            return None
        return max(0, self.vram_total_mb - self.vram_used_mb)


@dataclass
class SystemProfile:
    """What this machine actually is, as measured a moment ago."""

    hostname: str = ""
    os_name: str = ""
    os_release: str = ""
    arch: str = ""
    python_version: str = ""
    cpu_cores_logical: Optional[int] = None
    cpu_cores_physical: Optional[int] = None
    cpu_model: str = ""
    ram_total_mb: Optional[int] = None
    ram_available_mb: Optional[int] = None
    gpus: List[GPU] = field(default_factory=list)
    accelerator: str = "cpu"  # nvidia | apple-silicon | amd | cpu
    npu: Dict[str, Any] = field(default_factory=lambda: {"detected": False, "details": []})
    ollama_models: List[Dict[str, Any]] = field(default_factory=list)
    ollama_reachable: bool = False
    probed_at: float = 0.0

    # -- derived ----------------------------------------------------------

    @property
    def has_gpu(self) -> bool:
        return bool(self.gpus)

    @property
    def total_vram_mb(self) -> Optional[int]:
        values = [g.vram_total_mb for g in self.gpus if g.vram_total_mb is not None]
        return sum(values) if values else None

    @property
    def free_vram_mb(self) -> Optional[int]:
        values = [g.vram_free_mb for g in self.gpus if g.vram_free_mb is not None]
        if values:
            return max(values)  # the biggest single card is what a model loads into
        if self.accelerator == "apple-silicon":
            return self.ram_available_mb  # unified memory
        return None

    @property
    def hottest_gpu_c(self) -> Optional[float]:
        temps = [g.temperature_c for g in self.gpus if g.temperature_c is not None]
        return max(temps) if temps else None

    def has_ollama_model(self, model: str) -> bool:
        """Ollama tags carry an explicit ``:tag``; a bare name means ``:latest``."""
        if not self.ollama_models:
            return False
        wanted = model if ":" in model else f"{model}:latest"
        return any(entry.get("name") == wanted for entry in self.ollama_models)

    def summary(self) -> Dict[str, Any]:
        """Compact form for /status and logs."""
        return {
            "hostname": self.hostname,
            "os": f"{self.os_name} {self.os_release}".strip(),
            "arch": self.arch,
            "accelerator": self.accelerator,
            "cpu_cores": self.cpu_cores_logical,
            "ram_total_mb": self.ram_total_mb,
            "ram_available_mb": self.ram_available_mb,
            "gpus": [
                {
                    "name": g.name,
                    "vram_total_mb": g.vram_total_mb,
                    "vram_free_mb": g.vram_free_mb,
                    "temperature_c": g.temperature_c,
                }
                for g in self.gpus
            ],
            "npu_detected": self.npu.get("detected", False),
            "ollama_reachable": self.ollama_reachable,
            "ollama_models": [m.get("name") for m in self.ollama_models],
            "probed_at": self.probed_at,
        }

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# -- individual probes -----------------------------------------------------


def probe_nvidia() -> List[GPU]:
    fields = "index,name,memory.total,memory.used,temperature.gpu,utilization.gpu"
    out = _run(["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"])
    if not out:
        return []

    gpus: List[GPU] = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2:
            continue

        def number(value: str):
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        total = number(parts[2]) if len(parts) > 2 else None
        used = number(parts[3]) if len(parts) > 3 else None
        gpus.append(
            GPU(
                index=int(number(parts[0]) or len(gpus)),
                name=parts[1],
                vram_total_mb=int(total) if total is not None else None,
                vram_used_mb=int(used) if used is not None else None,
                temperature_c=number(parts[4]) if len(parts) > 4 else None,
                utilization_pct=number(parts[5]) if len(parts) > 5 else None,
                vendor="nvidia",
            )
        )
    return gpus


def probe_amd() -> List[GPU]:
    out = _run(["rocm-smi", "--showtemp", "--showmeminfo", "vram", "--json"])
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []

    gpus: List[GPU] = []
    for index, (card, values) in enumerate(sorted(data.items())):
        if not isinstance(values, dict):
            continue

        def find(*needles):
            for key, value in values.items():
                lowered = key.lower()
                if all(n in lowered for n in needles):
                    try:
                        return float(value)
                    except (TypeError, ValueError):
                        return None
            return None

        total = find("vram", "total")
        used = find("vram", "used")
        gpus.append(
            GPU(
                index=index,
                name=values.get("Card series") or values.get("Card model") or card,
                vram_total_mb=int(total / 1024 / 1024) if total else None,
                vram_used_mb=int(used / 1024 / 1024) if used else None,
                temperature_c=find("temperature", "edge") or find("temperature"),
                vendor="amd",
            )
        )
    return gpus


def probe_apple_silicon() -> List[GPU]:
    """Apple Silicon shares one memory pool; report it as a single device."""
    if platform.system() != "Darwin" or platform.machine() not in ("arm64", "aarch64"):
        return []
    brand = _run(["sysctl", "-n", "machdep.cpu.brand_string"]) or "Apple Silicon"
    memsize = _run(["sysctl", "-n", "hw.memsize"])
    total_mb = int(int(memsize) / 1024 / 1024) if memsize and memsize.isdigit() else None
    return [GPU(index=0, name=f"{brand} (unified memory)", vram_total_mb=total_mb, vendor="apple")]


def probe_memory() -> Dict[str, Optional[int]]:
    system = platform.system()

    if system == "Linux":
        try:
            values = {}
            with open("/proc/meminfo", "r", encoding="utf-8") as handle:
                for line in handle:
                    key, _, rest = line.partition(":")
                    number = rest.strip().split(" ")[0]
                    if number.isdigit():
                        values[key] = int(number) // 1024  # kB -> MB
            return {
                "ram_total_mb": values.get("MemTotal"),
                "ram_available_mb": values.get("MemAvailable", values.get("MemFree")),
            }
        except OSError:
            return {"ram_total_mb": None, "ram_available_mb": None}

    if system == "Darwin":
        memsize = _run(["sysctl", "-n", "hw.memsize"])
        total = int(int(memsize) / 1024 / 1024) if memsize and memsize.isdigit() else None
        available = None
        vm_stat = _run(["vm_stat"])
        if vm_stat:
            page_size, free_pages = 4096, 0
            for line in vm_stat.splitlines():
                if "page size of" in line:
                    digits = "".join(c for c in line.split("page size of")[1] if c.isdigit())
                    page_size = int(digits) if digits else page_size
                if line.startswith(("Pages free", "Pages inactive")):
                    digits = "".join(c for c in line.split(":")[1] if c.isdigit())
                    free_pages += int(digits) if digits else 0
            available = int(free_pages * page_size / 1024 / 1024) or None
        return {"ram_total_mb": total, "ram_available_mb": available}

    if system == "Windows":
        class MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        try:
            status = MemoryStatusEx()
            status.dwLength = ctypes.sizeof(MemoryStatusEx)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
            return {
                "ram_total_mb": int(status.ullTotalPhys / 1024 / 1024),
                "ram_available_mb": int(status.ullAvailPhys / 1024 / 1024),
            }
        except Exception:
            return {"ram_total_mb": None, "ram_available_mb": None}

    return {"ram_total_mb": None, "ram_available_mb": None}


def probe_cpu() -> Dict[str, Any]:
    system = platform.system()
    logical = os.cpu_count()
    physical: Optional[int] = None
    model = platform.processor() or ""

    if system == "Linux":
        try:
            core_ids = set()
            with open("/proc/cpuinfo", "r", encoding="utf-8") as handle:
                physical_id = None
                for line in handle:
                    if line.startswith("model name") and not model:
                        model = line.split(":", 1)[1].strip()
                    elif line.startswith("physical id"):
                        physical_id = line.split(":", 1)[1].strip()
                    elif line.startswith("core id"):
                        core_ids.add((physical_id, line.split(":", 1)[1].strip()))
            physical = len(core_ids) or None
        except OSError:
            physical = None
    elif system == "Darwin":
        value = _run(["sysctl", "-n", "hw.physicalcpu"])
        physical = int(value) if value and value.isdigit() else None
        model = _run(["sysctl", "-n", "machdep.cpu.brand_string"]) or model
    elif system == "Windows":
        physical = int(os.environ.get("NUMBER_OF_PROCESSORS", 0)) or None
        model = os.environ.get("PROCESSOR_IDENTIFIER", model)

    return {"cpu_cores_logical": logical, "cpu_cores_physical": physical, "cpu_model": model}


def probe_npu() -> Dict[str, Any]:
    """Best-effort NPU detection.

    There is no portable NPU query. Rather than claim a capability this cannot
    verify, this reports what it actually saw and nothing more.
    """
    details: List[str] = []

    if platform.system() == "Windows":
        out = _run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_PnPEntity | "
             "Where-Object { $_.Name -match 'NPU|Neural|AI Boost' } | "
             "Select-Object -ExpandProperty Name"],
            timeout=10.0,
        )
        if out:
            details = [line.strip() for line in out.splitlines() if line.strip()]
    elif platform.system() == "Darwin":
        # Every Apple Silicon part ships a Neural Engine.
        if platform.machine() in ("arm64", "aarch64"):
            details = ["Apple Neural Engine"]

    return {"detected": bool(details), "details": details}


def probe_ollama(base_url: str = "http://localhost:11434", timeout: float = 2.0) -> Dict[str, Any]:
    """Ask the local Ollama which models are actually pulled.

    This is what turns "route to the local box" from a hope into a fact: a
    provider whose model is not installed can be skipped before the call.
    """
    try:
        request = urllib.request.Request(f"{base_url.rstrip('/')}/api/tags", method="GET")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError):
        return {"reachable": False, "models": []}

    models = [
        {
            "name": entry.get("name", ""),
            "size_mb": int(entry.get("size", 0) / 1024 / 1024) if entry.get("size") else None,
            "family": (entry.get("details") or {}).get("family", ""),
        }
        for entry in data.get("models", [])
    ]
    return {"reachable": True, "models": models}


def probe(ollama_url: str = "http://localhost:11434", time_fn=time.time) -> SystemProfile:
    """Measure the machine. Never raises."""
    gpus = probe_nvidia() or probe_apple_silicon() or probe_amd()
    accelerator = gpus[0].vendor if gpus else "cpu"
    if accelerator == "apple":
        accelerator = "apple-silicon"

    ollama = probe_ollama(ollama_url)
    memory = probe_memory()
    cpu = probe_cpu()

    return SystemProfile(
        hostname=socket.gethostname(),
        os_name=platform.system(),
        os_release=platform.release(),
        arch=platform.machine(),
        python_version=platform.python_version(),
        gpus=gpus,
        accelerator=accelerator,
        npu=probe_npu(),
        ollama_models=ollama["models"],
        ollama_reachable=ollama["reachable"],
        probed_at=time_fn(),
        **memory,
        **cpu,
    )


class SystemProbe:
    """Caches a profile for a short while — routing must not shell out per request."""

    def __init__(
        self,
        ttl_seconds: float = 30.0,
        ollama_url: str = "http://localhost:11434",
        time_fn=time.time,
        probe_fn=None,
    ):
        self.ttl_seconds = ttl_seconds
        self.ollama_url = ollama_url
        self._time = time_fn
        self._probe_fn = probe_fn or (lambda: probe(self.ollama_url, time_fn=self._time))
        self._cached: Optional[SystemProfile] = None
        self._cached_at = 0.0
        self._lock = threading.Lock()

    def profile(self) -> SystemProfile:
        with self._lock:
            now = self._time()
            if self._cached is None or now - self._cached_at >= self.ttl_seconds:
                self._cached = self._probe_fn()
                self._cached_at = now
            return self._cached

    def refresh(self) -> SystemProfile:
        with self._lock:
            self._cached = self._probe_fn()
            self._cached_at = self._time()
            return self._cached
