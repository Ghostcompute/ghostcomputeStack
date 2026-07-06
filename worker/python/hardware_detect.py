"""Detect CPU and GPUs (NVIDIA, AMD) for the Ghost Compute desktop worker."""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys

ComputeMode = str  # "auto" | "cpu" | "gpu"


def _float(val: str, default: float = 0.0) -> float:
    val = (val or "").strip()
    if not val or val.upper() in ("N/A", "[N/A]"):
        return default
    try:
        return float(val)
    except ValueError:
        return default


def _run_cmd(args: list[str], timeout: int = 8) -> str | None:
    try:
        out = subprocess.check_output(
            args,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0,
        )
        text = out.decode(errors="replace").strip()
        return text if text else None
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def _nvidia_smi_bin() -> str:
    override = os.getenv("NVIDIA_SMI_BIN", "").strip()
    if override:
        return override
    found = shutil.which("nvidia-smi")
    if found:
        return found
    if sys.platform == "win32":
        for path in (
            os.path.expandvars(r"%ProgramFiles%\NVIDIA Corporation\NVSMI\nvidia-smi.exe"),
            r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
            os.path.expandvars(r"%SystemRoot%\System32\nvidia-smi.exe"),
        ):
            if path and os.path.isfile(path):
                return path
    return "nvidia-smi"


def _rocm_smi_bin() -> str | None:
    override = os.getenv("ROCM_SMI_BIN", "").strip()
    if override and os.path.isfile(override):
        return override
    return shutil.which("rocm-smi") or shutil.which("amd-smi")


def empty_gpu(name: str = "No GPU selected") -> dict:
    return {
        "vendor": "none", "name": name, "index": 0,
        "vram_used_gb": 0.0, "vram_total_gb": 0.0,
        "utilization": 0, "temperature": 0,
        "power_w": 0, "power_max_w": 0,
        "detected": False, "stats_available": False,
    }


def empty_cpu(name: str = "Detecting CPU…") -> dict:
    return {"name": name, "cores": 0, "threads": os.cpu_count() or 0, "detected": False}


def detect_cpu() -> dict:
    threads = os.cpu_count() or 0
    name = platform.processor().strip() or ""

    if sys.platform == "win32":
        out = _run_cmd(["wmic", "cpu", "get", "Name", "/format:list"])
        if out:
            for line in out.splitlines():
                if line.lower().startswith("name="):
                    name = line.split("=", 1)[1].strip()
                    break
    elif sys.platform == "linux":
        try:
            with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if "model name" in line:
                        name = line.split(":", 1)[1].strip()
                        break
        except OSError:
            pass
    elif sys.platform == "darwin":
        out = _run_cmd(["sysctl", "-n", "machdep.cpu.brand_string"])
        if out:
            name = out.strip()

    cores = threads
    if sys.platform == "win32":
        out = _run_cmd(["wmic", "cpu", "get", "NumberOfCores", "/format:list"])
        if out:
            for line in out.splitlines():
                if line.lower().startswith("numberofcores="):
                    cores = int(_float(line.split("=", 1)[1], threads))
                    break

    if not name:
        name = f"{platform.system()} CPU"
    return {"name": name, "cores": cores, "threads": threads, "detected": bool(name and threads > 0)}


def _gpu_entry(vendor, name, index, *, vram_used_gb=0.0, vram_total_gb=0.0,
               utilization=0, temperature=0, power_w=0, power_max_w=0, stats_available=False) -> dict:
    return {
        "vendor": vendor, "name": name, "index": index,
        "vram_used_gb": vram_used_gb, "vram_total_gb": vram_total_gb,
        "utilization": utilization, "temperature": temperature,
        "power_w": power_w, "power_max_w": power_max_w,
        "detected": True, "stats_available": stats_available,
    }


def detect_nvidia_gpus() -> list[dict]:
    cmd = [
        _nvidia_smi_bin(),
        "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit",
        "--format=csv,noheader,nounits",
    ]
    out = _run_cmd(cmd)
    if not out:
        return []
    gpus: list[dict] = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 8:
            continue
        idx = int(_float(parts[0], len(gpus)))
        gpus.append(_gpu_entry(
            "nvidia", parts[1], idx,
            vram_used_gb=round(_float(parts[2]) / 1024, 1),
            vram_total_gb=round(_float(parts[3]) / 1024, 1),
            utilization=int(_float(parts[4])),
            temperature=int(_float(parts[5])),
            power_w=round(_float(parts[6])),
            power_max_w=max(round(_float(parts[7])), 1),
            stats_available=True,
        ))
    return gpus


def _detect_amd_rocm() -> list[dict]:
    bin_path = _rocm_smi_bin()
    if not bin_path:
        return []
    names_out = _run_cmd([bin_path, "--showproductname"])
    if not names_out:
        return []
    names: list[str] = []
    for line in names_out.splitlines():
        line = line.strip()
        if not line or line.startswith("=") or "GPU" not in line.upper():
            continue
        if ":" in line:
            names.append(line.split(":", 1)[1].strip())
    mem_out = _run_cmd([bin_path, "--showmeminfo", "vram"])
    use_out = _run_cmd([bin_path, "-u"])
    gpus: list[dict] = []
    for i, name in enumerate(names):
        vram_total = vram_used = 0.0
        util = 0
        if mem_out:
            blocks = re.split(r"GPU\[\d+\]", mem_out)
            if i + 1 < len(blocks):
                block = blocks[i + 1]
                m = re.search(r"VRAM Total Memory \(B\)\s*:\s*(\d+)", block)
                u = re.search(r"VRAM Total Used Memory \(B\)\s*:\s*(\d+)", block)
                if m:
                    vram_total = round(int(m.group(1)) / (1024 ** 3), 1)
                if u:
                    vram_used = round(int(u.group(1)) / (1024 ** 3), 1)
        if use_out:
            for line in use_out.splitlines():
                if f"GPU[{i}]" in line:
                    pct = re.search(r"(\d+)\s*%", line)
                    if pct:
                        util = int(pct.group(1))
        gpus.append(_gpu_entry("amd", name, i, vram_used_gb=vram_used, vram_total_gb=vram_total,
                               utilization=util, stats_available=True))
    return gpus


def _detect_gpus_wmic() -> list[dict]:
    if sys.platform != "win32":
        return []
    out = _run_cmd(["wmic", "path", "win32_VideoController", "get", "Name,AdapterRAM", "/format:csv"])
    if not out:
        return []
    gpus: list[dict] = []
    idx = 0
    for line in out.splitlines():
        if not line.strip() or line.lower().startswith("node,"):
            continue
        parts = line.split(",")
        if len(parts) < 3:
            continue
        name = parts[2].strip()
        if not name or "microsoft" in name.lower() or "basic" in name.lower():
            continue
        vendor = ("amd" if re.search(r"amd|radeon", name, re.I)
                  else "nvidia" if re.search(r"nvidia|geforce|rtx|gtx", name, re.I) else "unknown")
        if vendor == "unknown":
            continue
        vram_gb = round(_float(parts[1], 0) / (1024 ** 3), 1) if _float(parts[1]) > 0 else 0.0
        gpus.append(_gpu_entry(vendor, name, idx, vram_total_gb=vram_gb, stats_available=False))
        idx += 1
    return gpus


def _detect_gpus_lspci() -> list[dict]:
    if sys.platform == "linux" and shutil.which("lspci"):
        out = _run_cmd(["lspci"])
        if not out:
            return []
        gpus: list[dict] = []
        idx = 0
        for line in out.splitlines():
            lower = line.lower()
            if "vga" not in lower and "3d" not in lower and "display" not in lower:
                continue
            if not re.search(r"nvidia|amd|radeon|geforce|rtx", lower):
                continue
            name = line.split(":", 2)[-1].strip() if ":" in line else line.strip()
            vendor = "amd" if re.search(r"amd|radeon", name, re.I) else "nvidia"
            gpus.append(_gpu_entry(vendor, name, idx, stats_available=False))
            idx += 1
        return gpus
    return []


def detect_all_gpus() -> list[dict]:
    gpus = detect_nvidia_gpus()
    if gpus:
        return gpus
    gpus = _detect_amd_rocm()
    if gpus:
        return gpus
    gpus = _detect_gpus_wmic()
    if gpus:
        return gpus
    return _detect_gpus_lspci()


def normalize_compute_mode(mode: str | None) -> ComputeMode:
    m = (mode or "auto").strip().lower()
    return m if m in ("cpu", "gpu", "auto") else "auto"


def effective_compute_mode(compute_mode: ComputeMode, gpus: list[dict]) -> ComputeMode:
    mode = normalize_compute_mode(compute_mode)
    if mode == "auto":
        return "gpu" if gpus else "cpu"
    return mode


def select_gpu(gpus: list[dict], gpu_index: int) -> dict | None:
    if not gpus:
        return None
    for g in gpus:
        if g.get("index") == gpu_index:
            return g
    return gpus[0]


def active_device_display(compute_mode: ComputeMode, cpu: dict, gpus: list[dict], gpu_index: int) -> dict:
    mode = effective_compute_mode(compute_mode, gpus)
    if mode == "cpu":
        return {
            "vendor": "cpu", "name": cpu.get("name") or "CPU", "index": -1,
            "vram_used_gb": 0.0, "vram_total_gb": 0.0, "utilization": 0,
            "temperature": 0, "power_w": 0, "power_max_w": 0,
            "detected": cpu.get("detected", False), "stats_available": False,
            "cores": cpu.get("cores", 0), "threads": cpu.get("threads", 0),
        }
    gpu = select_gpu(gpus, gpu_index)
    return dict(gpu) if gpu else empty_gpu("No GPU detected")


def hardware_tier_label(compute_mode: ComputeMode, cpu: dict, gpus: list[dict], gpu_index: int) -> str:
    override = os.getenv("GHOST_HW_TIER", "").strip()
    if override:
        return override
    mode = effective_compute_mode(compute_mode, gpus)
    if mode == "cpu":
        return f"CPU · {cpu.get('name', 'Unknown CPU')}"
    gpu = select_gpu(gpus, gpu_index)
    if gpu:
        prefix = "AMD" if gpu.get("vendor") == "amd" else "NVIDIA" if gpu.get("vendor") == "nvidia" else ""
        name = gpu.get("name", "GPU")
        return f"{prefix} {name}" if prefix and prefix.lower() not in name.lower() else name
    return "CPU · " + cpu.get("name", "Unknown")


def can_start(compute_mode: ComputeMode, cpu: dict, gpus: list[dict]) -> tuple[bool, str | None]:
    mode = normalize_compute_mode(compute_mode)
    if mode == "gpu" and not gpus:
        return False, "No GPU detected. Install NVIDIA or AMD drivers, or switch to CPU mode."
    if mode == "cpu" and not cpu.get("detected"):
        return False, "Could not detect CPU on this machine."
    if mode == "auto" and not cpu.get("detected") and not gpus:
        return False, "No compute device detected."
    return True, None


def scan_hardware(compute_mode: ComputeMode = "auto", gpu_index: int = 0) -> dict:
    cpu = detect_cpu()
    gpus = detect_all_gpus()
    effective = effective_compute_mode(compute_mode, gpus)
    display = active_device_display(compute_mode, cpu, gpus, gpu_index)
    return {
        "cpu": cpu, "gpus": gpus, "gpu_index": gpu_index,
        "compute_mode": normalize_compute_mode(compute_mode),
        "effective_compute": effective, "display": display,
        "gpu_detected": len(gpus) > 0,
        "hardware_tier": hardware_tier_label(compute_mode, cpu, gpus, gpu_index),
    }
