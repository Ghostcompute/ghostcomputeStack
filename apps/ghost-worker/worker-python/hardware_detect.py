"""Detect CPU and GPUs (NVIDIA, AMD) for the Ghost Compute desktop worker."""

from __future__ import annotations

import json
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
               utilization=0, temperature=0, power_w=0, power_max_w=0, stats_available=False,
               pci_slot: str | None = None, driver: str | None = None, source: str = "unknown") -> dict:
    return {
        "vendor": vendor, "name": name, "index": index,
        "vram_used_gb": vram_used_gb, "vram_total_gb": vram_total_gb,
        "utilization": utilization, "temperature": temperature,
        "power_w": power_w, "power_max_w": power_max_w,
        "detected": True, "stats_available": stats_available,
        "pci_slot": pci_slot, "driver": driver, "source": source,
    }


def _format_pci_slot(pci: str | None) -> str | None:
    """Normalize domain:bus:device.fn to bus:device.fn for display."""
    if not pci:
        return None
    s = pci.strip()
    if not s:
        return None
    s = s.replace(" ", "")
    if ":" in s:
        parts = [p for p in s.split(":") if p]
        if len(parts) >= 3:
            return f"{parts[-2]}:{parts[-1]}"
        if len(parts) == 2:
            return f"{parts[0]}:{parts[1]}"
    return s


def _nvidia_smi_pci_by_index() -> dict[int, str]:
    out = _run_cmd([
        _nvidia_smi_bin(),
        "--query-gpu=index,pci.bus_id",
        "--format=csv,noheader,nounits",
    ])
    mapping: dict[int, str] = {}
    if not out:
        return mapping
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2:
            continue
        idx = int(_float(parts[0], len(mapping)))
        pci = _format_pci_slot(parts[1])
        if pci:
            mapping[idx] = pci
    return mapping


def _enrich_pci_slots(gpus: list[dict]) -> None:
    pci_map = _nvidia_smi_pci_by_index()
    for g in gpus:
        existing = _format_pci_slot(g.get("pci_slot"))
        if existing:
            g["pci_slot"] = existing
            continue
        idx = int(g.get("index", 0))
        pci = pci_map.get(idx)
        if pci:
            g["pci_slot"] = pci


def _is_bmc_or_virtual(name: str, vendor: str = "", driver: str = "") -> bool:
    blob = f"{name} {vendor} {driver}".lower()
    skip = (
        "aspeed", "ast", "matrox", "g200", "g200e", "g200ew", "g200er",
        "microsoft basic", "basic display", "virtualbox", "vmware", "qemu",
        "cirrus", "vga compatible controller [red hat",
    )
    return any(s in blob for s in skip)


def _format_gpu_name(vendor: str, product: str) -> str:
    product = (product or "").strip()
    vendor = (vendor or "").strip()
    if not product:
        return vendor or "Unknown GPU"
    if vendor and vendor.lower() not in product.lower():
        short = re.sub(r"\s*\[.*?\]\s*", " ", vendor).strip()
        short = re.sub(r"Advanced Micro Devices, Inc\.?", "AMD", short, flags=re.I)
        short = re.sub(r"\s*\[AMD/ATI\]\s*", " ", short, flags=re.I).strip()
        if short and short.lower() not in product.lower():
            return f"{short} {product}".strip()
    return product


def detect_nvidia_nvml() -> list[dict]:
    try:
        import pynvml  # nvidia-ml-py
    except ImportError:
        return []
    try:
        pynvml.nvmlInit()
    except Exception:
        return []
    gpus: list[dict] = []
    try:
        count = pynvml.nvmlDeviceGetCount()
        for i in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            raw_name = pynvml.nvmlDeviceGetName(handle)
            name = raw_name.decode() if isinstance(raw_name, bytes) else str(raw_name)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            temp = 0
            power = power_max = 0
            try:
                temp = int(pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU))
            except Exception:
                pass
            try:
                power = int(pynvml.nvmlDeviceGetPowerUsage(handle) / 1000)
                power_max = int(pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000)
            except Exception:
                pass
            pci = ""
            try:
                raw = pynvml.nvmlDeviceGetPciInfo(handle).busId
                pci = raw.decode() if isinstance(raw, bytes) else str(raw)
            except Exception:
                pass
            gpus.append(_gpu_entry(
                "nvidia", name, i,
                vram_used_gb=round(mem.used / (1024 ** 3), 1),
                vram_total_gb=round(mem.total / (1024 ** 3), 1),
                utilization=int(getattr(util, "gpu", 0)),
                temperature=temp,
                power_w=power,
                power_max_w=max(power_max, 1),
                stats_available=True,
                pci_slot=_format_pci_slot(pci),
                driver="nvidia",
                source="nvml",
            ))
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass
    return gpus


def detect_amd_pyamdgpuinfo() -> list[dict]:
    if sys.platform != "linux":
        return []
    try:
        import pyamdgpuinfo
    except ImportError:
        return []
    try:
        count = pyamdgpuinfo.detect_gpus()
    except Exception:
        return []
    gpus: list[dict] = []
    for i in range(count):
        try:
            gpu = pyamdgpuinfo.get_gpu(i)
            name = str(getattr(gpu, "name", "") or "AMD Radeon GPU")
            mem = getattr(gpu, "memory_info", None)
            if not isinstance(mem, dict):
                mem = {}
            vram_total = round(float(mem.get("vram_size", 0)) / (1024 ** 3), 1)
            vram_used = round(float(gpu.query_vram_usage()) / (1024 ** 3), 1) if hasattr(gpu, "query_vram_usage") else 0.0
            util = int(round(float(gpu.query_load()) * 100)) if hasattr(gpu, "query_load") else 0
            temp = int(float(gpu.query_temperature())) if hasattr(gpu, "query_temperature") else 0
            power = int(float(gpu.query_power())) if hasattr(gpu, "query_power") else 0
            pci = str(getattr(gpu, "pci_slot", "") or "")
            gpus.append(_gpu_entry(
                "amd", name, i,
                vram_used_gb=vram_used,
                vram_total_gb=vram_total,
                utilization=util,
                temperature=temp,
                power_w=power,
                stats_available=True,
                pci_slot=pci or None,
                driver="amdgpu",
                source="pyamdgpuinfo",
            ))
        except Exception:
            continue
    return gpus


def _read_sysfs_int(path: str) -> int | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return int(f.read().strip())
    except OSError:
        return None


def _detect_gpus_sysfs_linux() -> list[dict]:
    if sys.platform != "linux":
        return []
    drm_root = "/sys/class/drm"
    if not os.path.isdir(drm_root):
        return []
    gpus: list[dict] = []
    idx = 0
    for entry in sorted(os.listdir(drm_root)):
        if not re.fullmatch(r"card\d+", entry):
            continue
        dev = os.path.join(drm_root, entry, "device")
        if not os.path.isdir(dev):
            continue
        driver = ""
        uevent = os.path.join(dev, "uevent")
        try:
            with open(uevent, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("DRIVER="):
                        driver = line.split("=", 1)[1].strip()
        except OSError:
            pass
        pci_slot = ""
        try:
            with open(uevent, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("PCI_SLOT_NAME="):
                        pci_slot = line.split("=", 1)[1].strip()
        except OSError:
            pass
        product = ""
        for candidate in ("product_name", "name", "product"):
            p = os.path.join(dev, candidate)
            if os.path.isfile(p):
                try:
                    with open(p, encoding="utf-8", errors="replace") as f:
                        product = f.read().strip()
                        if product:
                            break
                except OSError:
                    pass
        vendor_id = device_id = ""
        for candidate in ("vendor", "device"):
            p = os.path.join(dev, candidate)
            if os.path.isfile(p):
                try:
                    with open(p, encoding="utf-8", errors="replace") as f:
                        val = f.read().strip()
                        if candidate == "vendor":
                            vendor_id = val
                        else:
                            device_id = val
                except OSError:
                    pass
        vram_total_b = _read_sysfs_int(os.path.join(dev, "mem_info_vram_total"))
        vram_used_b = _read_sysfs_int(os.path.join(dev, "mem_info_vram_used"))
        vendor = "nvidia" if driver == "nvidia" else "amd" if driver == "amdgpu" else "unknown"
        name = product or f"GPU {pci_slot or entry}"
        if _is_bmc_or_virtual(name, vendor_id, driver):
            continue
        if vendor == "unknown" and not re.search(r"nvidia|amd|radeon|geforce|rtx", name, re.I):
            continue
        gpus.append(_gpu_entry(
            vendor if vendor != "unknown" else ("amd" if re.search(r"amd|radeon", name, re.I) else "nvidia"),
            name, idx,
            vram_total_gb=round(vram_total_b / (1024 ** 3), 1) if vram_total_b else 0.0,
            vram_used_gb=round(vram_used_b / (1024 ** 3), 1) if vram_used_b else 0.0,
            stats_available=bool(vram_total_b),
            pci_slot=pci_slot or None,
            driver=driver or None,
            source="sysfs",
        ))
        idx += 1
    return gpus


def _detect_gpus_lshw() -> list[dict]:
    if sys.platform != "linux" or not shutil.which("lshw"):
        return []
    out = _run_cmd(["lshw", "-C", "display", "-json"], timeout=15)
    if not out:
        return []
    try:
        items = json.loads(out)
    except json.JSONDecodeError:
        return []
    if isinstance(items, dict):
        items = [items]
    gpus: list[dict] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        vendor = str(item.get("vendor") or "")
        product = str(item.get("product") or "")
        driver = str((item.get("configuration") or {}).get("driver") or "")
        if _is_bmc_or_virtual(product, vendor, driver):
            continue
        if not re.search(r"nvidia|amd|radeon|geforce|rtx|intel", f"{vendor} {product}", re.I):
            continue
        name = _format_gpu_name(vendor, product)
        ven = "nvidia" if re.search(r"nvidia|geforce|rtx", name, re.I) else "amd" if re.search(r"amd|radeon", name, re.I) else "intel"
        gpus.append(_gpu_entry(
            ven, name, i,
            pci_slot=str(item.get("businfo") or "").replace("pci@", "") or None,
            driver=driver or None,
            stats_available=False,
            source="lshw",
        ))
    return gpus


def _detect_gpus_lspci_vmm() -> list[dict]:
    if sys.platform != "linux" or not shutil.which("lspci"):
        return []
    out = _run_cmd(["lspci", "-vmm"])
    if not out:
        return _detect_gpus_lspci()
    blocks = re.split(r"\n(?=\w)", out.strip())
    gpus: list[dict] = []
    idx = 0
    for block in blocks:
        cls = vendor = device = slot = ""
        for line in block.splitlines():
            if ":" not in line:
                continue
            key, val = line.split(":", 1)
            key, val = key.strip(), val.strip()
            if key == "Class":
                cls = val
            elif key == "Vendor":
                vendor = val
            elif key == "Device":
                device = val
            elif key == "Slot":
                slot = val
        if "vga" not in cls.lower() and "3d" not in cls.lower() and "display" not in cls.lower():
            continue
        if _is_bmc_or_virtual(device, vendor):
            continue
        if not re.search(r"nvidia|amd|radeon|geforce|rtx", f"{vendor} {device}", re.I):
            continue
        name = _format_gpu_name(vendor, device)
        ven = "amd" if re.search(r"amd|radeon", name, re.I) else "nvidia"
        gpus.append(_gpu_entry(ven, name, idx, pci_slot=slot or None, stats_available=False, source="lspci"))
        idx += 1
    return gpus


def _gpu_rank(g: dict) -> tuple:
    """Prefer discrete GPUs with live stats over BMC/iGPU fallbacks."""
    name = str(g.get("name", "")).lower()
    score = 0
    if g.get("stats_available"):
        score += 100
    if g.get("source") in ("nvml", "pyamdgpuinfo", "nvidia-smi", "rocm-smi"):
        score += 80
    if re.search(r"rtx|geforce|rx |radeon rx|instinct|mi300|h100|h200|a100", name):
        score += 60
    if g.get("vram_total_gb", 0) >= 8:
        score += 20
    if "integrated" in name or "granite ridge" in name or "raphael" in name:
        score -= 10
    return (-score, g.get("index", 0))


def _dedupe_gpus(gpus: list[dict]) -> list[dict]:
    seen: set[str] = set()
    unique: list[dict] = []
    for g in sorted(gpus, key=_gpu_rank):
        key = str(g.get("pci_slot") or g.get("name"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(g)
    for i, g in enumerate(unique):
        g["index"] = i
    return unique


def detect_nvidia_gpus() -> list[dict]:
    cmd = [
        _nvidia_smi_bin(),
        "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit,pci.bus_id",
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
        pci = _format_pci_slot(parts[8]) if len(parts) > 8 else None
        gpus.append(_gpu_entry(
            "nvidia", parts[1], idx,
            vram_used_gb=round(_float(parts[2]) / 1024, 1),
            vram_total_gb=round(_float(parts[3]) / 1024, 1),
            utilization=int(_float(parts[4])),
            temperature=int(_float(parts[5])),
            power_w=round(_float(parts[6])),
            power_max_w=max(round(_float(parts[7])), 1),
            stats_available=True,
            pci_slot=pci,
            driver="nvidia",
            source="nvidia-smi",
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
            slot = _format_pci_slot(line.split()[0]) if line.split() else None
            vendor = "amd" if re.search(r"amd|radeon", name, re.I) else "nvidia"
            gpus.append(_gpu_entry(vendor, name, idx, pci_slot=slot, stats_available=False))
            idx += 1
        return gpus
    return []


def detect_all_gpus() -> list[dict]:
    candidates: list[dict] = []
    for fn in (
        detect_nvidia_nvml,
        detect_nvidia_gpus,
        detect_amd_pyamdgpuinfo,
        _detect_amd_rocm,
        _detect_gpus_sysfs_linux,
        _detect_gpus_lshw,
        _detect_gpus_wmic,
        _detect_gpus_lspci_vmm,
    ):
        try:
            found = fn()
            if found:
                candidates.extend(found)
        except Exception:
            continue
    if not candidates:
        return []
    unique = _dedupe_gpus(candidates)
    _enrich_pci_slots(unique)
    return unique


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
