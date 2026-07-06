"""Model download, env persistence, and selection."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

import ollama_setup

from . import catalog

_downloads: dict[str, dict[str, Any]] = {}
_download_lock = threading.Lock()
_progress_trackers: dict[str, dict[str, float | int]] = {}

_OLLAMA_URLS = (
    os.getenv("GHOST_OLLAMA_URL", "").rstrip("/"),
    "http://127.0.0.1:11434",
    "http://localhost:11434",
)


def _app_dir() -> Path:
    here = Path(__file__).resolve()
    worker_py = here.parent.parent
    app_dir = worker_py.parent
    if (app_dir / "src-tauri").is_dir():
        return app_dir
    return worker_py


def _env_paths() -> list[Path]:
    app = _app_dir()
    paths = [app / ".env"]
    root = app.parent.parent
    if (root / "package.json").is_file() and (root / "apps" / "ghost-worker").is_dir():
        paths.append(root / ".env")
    return paths


def load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value and value[0] in "\"'" and value[-1] == value[0]:
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def write_env_var(key: str, value: str) -> None:
    app_env = _env_paths()[0]
    app_env.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    found = False
    if app_env.is_file():
        for line in app_env.read_text(encoding="utf-8").splitlines():
            if re.match(rf"^\s*{re.escape(key)}\s*=", line):
                lines.append(f"{key}={value}")
                found = True
            else:
                lines.append(line)
    if not found:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"{key}={value}")
    app_env.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.environ[key] = value


def _ollama_reachable() -> str | None:
    for url in _OLLAMA_URLS:
        if not url:
            continue
        if ollama_setup.is_reachable(url):
            return url.rstrip("/")
    try:
        return ollama_setup.ensure_ollama()
    except Exception:
        return None


def list_installed() -> dict[str, list[str]]:
    ollama: list[str] = []
    vllm: list[str] = []

    base = _ollama_reachable()
    if base:
        try:
            req = urllib.request.Request(f"{base}/api/tags")
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read())
            for item in data.get("models") or []:
                name = item.get("name") or item.get("model")
                if name:
                    ollama.append(str(name))
        except Exception:
            pass

    cache = Path.home() / ".cache" / "huggingface" / "hub"
    if cache.is_dir():
        for model_dir in cache.iterdir():
            if not model_dir.is_dir() or not model_dir.name.startswith("models--"):
                continue
            slug = model_dir.name[len("models--") :].replace("--", "/")
            if slug:
                vllm.append(slug)

    return {"ollama": sorted(set(ollama)), "vllm": sorted(set(vllm))}


def _installed_set(installed: dict[str, list[str]] | None = None) -> set[str]:
    data = installed if installed is not None else list_installed()
    out: set[str] = set()
    for backend in ("ollama", "vllm"):
        for name in data.get(backend, []):
            out.add(name)
            if backend == "ollama" and ":" in name:
                out.add(name.split(":")[0])
    return out


def get_selection() -> dict[str, str | None]:
    merged: dict[str, str] = {}
    for path in _env_paths():
        merged.update(load_env_file(path))
    merged.update(os.environ)

    ollama = merged.get("GHOST_OLLAMA_MODEL") or "llama3.2:3b"
    pref = (merged.get("GHOST_INFERENCE") or "ollama").lower()

    if pref == "ollama":
        return {"id": ollama, "backend": "ollama"}

    # Legacy vLLM path — not offered in the model catalog; kept for manual env overrides.
    vllm = merged.get("GHOST_VLLM_MODEL") or merged.get("DEFAULT_MODEL") or "llama3.2:3b"
    if pref == "vllm":
        return {"id": vllm, "backend": "vllm"}

    if _ollama_reachable():
        return {"id": ollama, "backend": "ollama"}
    return {"id": ollama, "backend": "ollama"}


def select_model(model_id: str, backend: str | None = None) -> dict[str, Any]:
    entry = catalog.get_catalog_entry(model_id)
    if not entry:
        raise ValueError(f"Unknown model: {model_id}")

    resolved_backend = backend or str(entry.get("backend") or "ollama")
    if resolved_backend not in ("ollama", "vllm"):
        raise ValueError(f"Invalid backend: {resolved_backend}")

    if resolved_backend == "ollama":
        write_env_var("GHOST_OLLAMA_MODEL", model_id)
        write_env_var("GHOST_INFERENCE", "ollama")
    else:
        write_env_var("DEFAULT_MODEL", model_id)
        write_env_var("GHOST_VLLM_MODEL", model_id)
        write_env_var("GHOST_INFERENCE", "vllm")

    import inference

    inference.apply_model_selection(model_id, resolved_backend)

    return {
        "ok": True,
        "id": model_id,
        "backend": resolved_backend,
        "needs_vllm_restart": resolved_backend == "vllm",
    }


def start_download(model_id: str) -> str:
    entry = catalog.get_catalog_entry(model_id)
    if not entry:
        raise ValueError(f"Unknown model: {model_id}")

    backend = str(entry.get("backend") or "")
    installed = _installed_set(list_installed())
    if catalog.is_model_installed(model_id, backend, installed):
        job_id = uuid.uuid4().hex[:12]
        total = _size_gb_to_bytes(float(entry.get("size_gb") or 0))
        with _download_lock:
            _downloads[job_id] = {
                "id": job_id,
                "model_id": model_id,
                "backend": backend,
                "status": "completed",
                "progress": 100,
                "message": "Already installed locally",
                "error": None,
                "bytes_done": total,
                "bytes_total": total,
                "speed_bps": 0,
                "started_at": time.time(),
                "finished_at": time.time(),
            }
        return job_id

    job_id = uuid.uuid4().hex[:12]
    total = _size_gb_to_bytes(float(entry.get("size_gb") or 0))
    with _download_lock:
        _downloads[job_id] = {
            "id": job_id,
            "model_id": model_id,
            "backend": entry.get("backend"),
            "status": "queued",
            "progress": 0,
            "message": "Queued",
            "error": None,
            "bytes_done": 0,
            "bytes_total": total,
            "speed_bps": 0,
            "started_at": time.time(),
            "finished_at": None,
        }

    thread = threading.Thread(
        target=_run_download,
        args=(job_id, dict(entry)),
        daemon=True,
    )
    thread.start()
    return job_id


def get_download_status(job_id: str) -> dict[str, Any] | None:
    with _download_lock:
        job = _downloads.get(job_id)
        return dict(job) if job else None


def _update_job(job_id: str, **fields: Any) -> None:
    with _download_lock:
        if job_id in _downloads:
            _downloads[job_id].update(fields)


def _clear_progress_tracker(job_id: str) -> None:
    _progress_trackers.pop(job_id, None)


def _track_progress(job_id: str, bytes_done: int, bytes_total: int, **fields: Any) -> None:
    now = time.time()
    tr = _progress_trackers.setdefault(
        job_id, {"last_bytes": 0, "last_time": now, "speed_bps": 0}
    )
    dt = now - float(tr["last_time"])
    if dt >= 0.35 and bytes_done > int(tr["last_bytes"]):
        tr["speed_bps"] = int((bytes_done - int(tr["last_bytes"])) / dt)
        tr["last_bytes"] = bytes_done
        tr["last_time"] = now
    _update_job(
        job_id,
        bytes_done=bytes_done,
        bytes_total=bytes_total,
        speed_bps=int(tr["speed_bps"]),
        **fields,
    )


def _size_gb_to_bytes(size_gb: float) -> int:
    if size_gb <= 0:
        return 0
    return int(size_gb * 1_000_000_000)


def _dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    total = 0
    try:
        for item in path.rglob("*"):
            if item.is_file():
                total += item.stat().st_size
    except OSError:
        pass
    return total


def _run_download(job_id: str, entry: dict[str, Any]) -> None:
    backend = entry.get("backend")
    model_id = str(entry.get("id") or "")
    size_gb = float(entry.get("size_gb") or 0)
    try:
        _track_progress(
            job_id,
            bytes_done=0,
            bytes_total=_size_gb_to_bytes(size_gb),
            status="downloading",
            message="Starting download…",
            progress=1,
        )
        if backend == "ollama":
            _download_ollama(job_id, model_id, size_gb)
        else:
            _download_vllm(job_id, model_id, size_gb)
        job = get_download_status(job_id) or {}
        total = int(job.get("bytes_total") or _size_gb_to_bytes(size_gb))
        done = int(job.get("bytes_done") or total)
        _update_job(
            job_id,
            status="completed",
            progress=100,
            message="Download complete",
            bytes_done=max(done, total) if total > 0 else done,
            bytes_total=total,
            speed_bps=0,
            finished_at=time.time(),
        )
    except Exception as exc:
        _update_job(
            job_id,
            status="failed",
            error=str(exc),
            message=str(exc),
            speed_bps=0,
            finished_at=time.time(),
        )
    finally:
        _clear_progress_tracker(job_id)


def _download_ollama(job_id: str, model_id: str, size_gb: float = 0) -> None:
    base = _ollama_reachable()
    if not base:
        raise RuntimeError(
            "Ollama is not available. Ghost Worker tried to install and start it automatically — "
            "check your network connection or install manually from https://ollama.com/download"
        )

    fallback_total = _size_gb_to_bytes(size_gb)
    _track_progress(
        job_id,
        bytes_done=0,
        bytes_total=fallback_total,
        status="downloading",
        message="Connecting to Ollama…",
        progress=3,
    )

    payload = json.dumps({"name": model_id, "stream": True}).encode()
    req = urllib.request.Request(
        f"{base}/api/pull",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=3600) as resp:
        while True:
            line = resp.readline()
            if not line:
                break
            try:
                chunk = json.loads(line.decode())
            except json.JSONDecodeError:
                continue
            status = chunk.get("status") or ""
            completed = chunk.get("completed")
            total = chunk.get("total")
            bytes_done = int(completed) if isinstance(completed, int) else 0
            bytes_total = int(total) if isinstance(total, int) and total > 0 else fallback_total
            progress = 5
            if bytes_total > 0 and bytes_done > 0:
                progress = max(5, min(99, int(bytes_done / bytes_total * 100)))
            _track_progress(
                job_id,
                bytes_done=bytes_done,
                bytes_total=bytes_total,
                status="downloading",
                message=status or "Downloading…",
                progress=progress,
            )


def _monitor_vllm_cache(
    job_id: str,
    cache_path: Path,
    total_bytes: int,
    stop: threading.Event,
) -> None:
    while not stop.is_set():
        done = _dir_size(cache_path)
        progress = 10
        if total_bytes > 0 and done > 0:
            progress = max(10, min(99, int(done / total_bytes * 100)))
        _track_progress(
            job_id,
            bytes_done=done,
            bytes_total=total_bytes,
            status="downloading",
            message="Fetching from HuggingFace…",
            progress=progress,
        )
        stop.wait(0.5)


def _download_vllm(job_id: str, model_id: str, size_gb: float = 0) -> None:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError(
            "HuggingFace download requires huggingface_hub in the worker Python env. "
            "Run: pip install huggingface_hub — or select the model and vLLM will "
            "download weights on first start."
        ) from exc

    cache_dir = Path.home() / ".cache" / "huggingface" / "hub"
    cache_slug = "models--" + model_id.replace("/", "--")
    cache_path = cache_dir / cache_slug
    total_bytes = _size_gb_to_bytes(size_gb)
    if cache_path.is_dir():
        _track_progress(
            job_id,
            bytes_done=_dir_size(cache_path),
            bytes_total=total_bytes,
            status="downloading",
            message="Verifying cached weights…",
            progress=40,
        )

    _track_progress(
        job_id,
        bytes_done=_dir_size(cache_path),
        bytes_total=total_bytes,
        status="downloading",
        message="Fetching from HuggingFace…",
        progress=10,
    )

    stop = threading.Event()
    monitor = threading.Thread(
        target=_monitor_vllm_cache,
        args=(job_id, cache_path, total_bytes, stop),
        daemon=True,
    )
    monitor.start()
    try:
        try:
            snapshot_download(
                repo_id=model_id,
                local_files_only=False,
                resume_download=True,
                tqdm_class=None,
            )
        except TypeError:
            snapshot_download(
                repo_id=model_id,
                local_files_only=False,
                resume_download=True,
            )
    finally:
        stop.set()
        monitor.join(timeout=2)

    final_size = _dir_size(cache_path)
    _track_progress(
        job_id,
        bytes_done=final_size,
        bytes_total=total_bytes or final_size,
        status="downloading",
        message="Weights cached locally",
        progress=99,
    )
