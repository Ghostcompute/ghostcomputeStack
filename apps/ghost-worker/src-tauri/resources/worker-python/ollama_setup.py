"""Install, start, and health-check Ollama for Ghost Worker."""

from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

log = logging.getLogger("ghost.ollama")

OLLAMA_PORT = 11434
OLLAMA_SETUP_URL = "https://ollama.com/download/OllamaSetup.exe"
StatusCallback = Callable[[str], None] | None

_ollama_child: subprocess.Popen | None = None
_ollama_child_lock = threading.Lock()


def _emit(on_status: StatusCallback, msg: str) -> None:
    log.info(msg)
    if on_status:
        on_status(msg)


def _subprocess_flags() -> int:
    if sys.platform == "win32":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


def _default_wait_timeout() -> float:
    if platform.system() == "Windows":
        return float(os.getenv("GHOST_OLLAMA_WAIT_SECS", "240"))
    return float(os.getenv("GHOST_OLLAMA_WAIT_SECS", "120"))


def ollama_urls() -> list[str]:
    urls: list[str] = []
    custom = (os.getenv("GHOST_OLLAMA_URL") or "").rstrip("/")
    if custom:
        urls.append(custom)
    urls.extend(["http://127.0.0.1:11434", "http://localhost:11434"])
    return urls


def is_reachable(url: str | None = None, timeout: float = 4) -> bool:
    candidates = [url] if url else ollama_urls()
    for base in candidates:
        if not base:
            continue
        try:
            req = urllib.request.Request(f"{base.rstrip('/')}/api/tags")
            with urllib.request.urlopen(req, timeout=timeout):
                return True
        except Exception:
            continue
    return False


def first_reachable_url() -> str | None:
    for url in ollama_urls():
        if url and is_reachable(url):
            return url.rstrip("/")
    return None


def _windows_paths() -> list[Path]:
    paths: list[Path] = []
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        base = Path(local) / "Programs" / "Ollama"
        paths.extend([base / "ollama.exe", base / "Ollama.exe"])
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    paths.append(Path(program_files) / "Ollama" / "ollama.exe")
    pf86 = os.environ.get("ProgramFiles(x86)", "")
    if pf86:
        paths.append(Path(pf86) / "Ollama" / "ollama.exe")
    return paths


def find_windows_app() -> Path | None:
    if platform.system() != "Windows":
        return None
    for path in _windows_paths():
        if path.name.lower() == "ollama.exe" and path.is_file():
            return path
    return None


def find_binary() -> str | None:
    found = shutil.which("ollama")
    if found:
        return found

    system = platform.system()
    candidates: list[Path] = []
    if system == "Darwin":
        candidates.extend(
            [
                Path("/usr/local/bin/ollama"),
                Path("/opt/homebrew/bin/ollama"),
                Path("/Applications/Ollama.app/Contents/Resources/ollama"),
            ]
        )
    elif system == "Linux":
        candidates.extend(
            [
                Path("/usr/local/bin/ollama"),
                Path("/usr/bin/ollama"),
                Path.home() / ".ollama" / "bin" / "ollama",
            ]
        )
    elif system == "Windows":
        candidates.extend(_windows_paths())

    for path in candidates:
        if path.is_file() and path.name.lower() == "ollama.exe":
            return str(path)
    return None


def _run(cmd: list[str] | str, *, shell: bool = False, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        shell=shell,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=_subprocess_flags(),
    )


def _skip_install() -> bool:
    return os.getenv("GHOST_SKIP_OLLAMA_INSTALL", "").lower() in ("1", "true", "yes")


def _wait_for_install_artifacts(timeout: float = 120, on_status: StatusCallback = None) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if find_binary() or find_windows_app() or is_reachable():
            return
        time.sleep(1)
    _emit(on_status, "Waiting for Ollama install to finish…")


def install_ollama(on_status: StatusCallback = None) -> None:
    if _skip_install():
        raise RuntimeError(
            "Ollama is not installed. Auto-install is disabled (GHOST_SKIP_OLLAMA_INSTALL)."
        )

    system = platform.system()
    _emit(on_status, "Ollama not found — installing automatically…")

    if system == "Windows":
        _install_windows(on_status)
    elif system == "Darwin":
        _install_macos(on_status)
    elif system == "Linux":
        _install_linux(on_status)
    else:
        raise RuntimeError(f"Unsupported platform for Ollama auto-install: {system}")

    _wait_for_install_artifacts(timeout=120, on_status=on_status)

    if find_binary() or find_windows_app() or is_reachable():
        return

    raise RuntimeError("Ollama install finished but the runtime was not detected. Retry in a moment.")


def _install_linux(on_status: StatusCallback) -> None:
    if not shutil.which("curl"):
        raise RuntimeError("curl not found — cannot auto-install Ollama on this system")
    _emit(on_status, "Running Ollama install script…")
    result = _run("curl -fsSL https://ollama.com/install.sh | sh", shell=True, timeout=600)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"Ollama install failed: {err or 'unknown error'}")


def _install_macos(on_status: StatusCallback) -> None:
    if shutil.which("brew"):
        _emit(on_status, "Installing Ollama via Homebrew…")
        result = _run(["brew", "install", "ollama"], timeout=600)
        if result.returncode == 0:
            return

    if shutil.which("curl"):
        _emit(on_status, "Running Ollama install script…")
        result = _run("curl -fsSL https://ollama.com/install.sh | sh", shell=True, timeout=600)
        if result.returncode == 0:
            return
        err = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"Ollama install failed: {err or 'unknown error'}")

    raise RuntimeError("Could not auto-install Ollama — install Homebrew or curl first")


def _install_windows_winget(on_status: StatusCallback) -> bool:
    winget = shutil.which("winget")
    if not winget:
        return False

    _emit(on_status, "Installing Ollama via winget…")
    result = _run(
        [
            winget,
            "install",
            "-e",
            "--id",
            "Ollama.Ollama",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--silent",
        ],
        timeout=900,
    )
    combined = f"{result.stdout or ''}\n{result.stderr or ''}".lower()
    if result.returncode == 0:
        return True
    if "already installed" in combined or "no available upgrade" in combined:
        return True
    log.warning("winget install failed (%s): %s", result.returncode, combined[:500])
    return False


def _install_windows_download(on_status: StatusCallback) -> None:
    _emit(on_status, "Downloading Ollama installer…")
    setup_path = Path(tempfile.gettempdir()) / "GhostWorker-OllamaSetup.exe"
    try:
        try:
            urllib.request.urlretrieve(OLLAMA_SETUP_URL, setup_path)
        except Exception as exc:
            raise RuntimeError(f"Could not download Ollama installer: {exc}") from exc

        _emit(on_status, "Running Ollama installer…")
        result = _run([str(setup_path), "/S"], timeout=900)
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(f"Ollama installer failed: {err or f'exit code {result.returncode}'}")
    finally:
        try:
            setup_path.unlink(missing_ok=True)
        except OSError:
            pass


def _install_windows(on_status: StatusCallback) -> None:
    if _install_windows_winget(on_status):
        _wait_for_install_artifacts(timeout=120, on_status=on_status)
        if find_binary() or find_windows_app() or is_reachable():
            return
    _install_windows_download(on_status)


def _launch_windows_app(on_status: StatusCallback) -> None:
    app = find_windows_app()
    if not app:
        return
    _emit(on_status, "Launching Ollama…")
    subprocess.Popen(
        [str(app)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        creationflags=_subprocess_flags(),
    )


def start_ollama(on_status: StatusCallback = None) -> None:
    global _ollama_child

    if is_reachable():
        return

    with _ollama_child_lock:
        if _ollama_child and _ollama_child.poll() is None:
            return

        system = platform.system()
        if system == "Windows":
            _launch_windows_app(on_status)
            if is_reachable(timeout=2):
                return

        binary = find_binary()
        if not binary and system == "Windows":
            _wait_for_install_artifacts(timeout=30, on_status=on_status)
            binary = find_binary()
            if not binary:
                _launch_windows_app(on_status)

        if not binary:
            if system == "Windows" and find_windows_app():
                return
            raise RuntimeError("Ollama binary not found after install")

        if system == "Darwin" and "Ollama.app" in binary:
            _emit(on_status, "Starting Ollama…")
            subprocess.Popen(["open", "-a", "Ollama"], start_new_session=True)
            return

        _emit(on_status, "Starting Ollama service…")
        _ollama_child = subprocess.Popen(
            [binary, "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            creationflags=_subprocess_flags(),
        )


def wait_for_ollama(timeout: float | None = None, on_status: StatusCallback = None) -> str:
    wait_secs = _default_wait_timeout() if timeout is None else timeout
    deadline = time.time() + wait_secs
    last_ping = 0.0
    while time.time() < deadline:
        url = first_reachable_url()
        if url:
            return url
        now = time.time()
        if on_status and now - last_ping >= 8:
            remaining = max(0, int(deadline - now))
            _emit(on_status, f"Waiting for Ollama to respond… ({remaining}s left)")
            last_ping = now
        if platform.system() == "Windows" and not is_reachable(timeout=1):
            binary = find_binary()
            if binary and (_ollama_child is None or _ollama_child.poll() is not None):
                try:
                    start_ollama(on_status)
                except Exception:
                    pass
        time.sleep(0.5)

    raise RuntimeError(
        f"Ollama did not respond on port {OLLAMA_PORT} within {int(wait_secs)}s. "
        "Check your network connection and retry."
    )


def ensure_ollama(timeout: float | None = None, on_status: StatusCallback = None) -> str:
    """Install if missing, start if stopped, wait until Ollama responds."""
    url = first_reachable_url()
    if url:
        return url

    if not find_binary() and not find_windows_app():
        install_ollama(on_status)

    start_ollama(on_status)
    return wait_for_ollama(timeout=timeout, on_status=on_status)


def model_installed(base_url: str, model_id: str) -> bool:
    try:
        req = urllib.request.Request(f"{base_url.rstrip('/')}/api/tags")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        names = {m.get("name", "") for m in data.get("models", [])}
        base = model_id.split(":")[0]
        for name in names:
            if name == model_id or name.startswith(f"{base}:") or name.split(":")[0] == base:
                return True
    except Exception:
        pass
    return False


def _pull_via_cli(model_id: str, on_status: StatusCallback) -> None:
    binary = find_binary()
    if not binary:
        raise RuntimeError("Ollama CLI not found for model pull")
    _emit(on_status, f"Pulling {model_id} via Ollama CLI…")
    result = subprocess.run(
        [binary, "pull", model_id],
        capture_output=True,
        text=True,
        timeout=3600,
        creationflags=_subprocess_flags(),
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(err or f"ollama pull failed with code {result.returncode}")


def ensure_model(base_url: str, model_id: str, on_status: StatusCallback = None) -> None:
    if model_installed(base_url, model_id):
        return

    _emit(on_status, f"Downloading model {model_id}…")
    payload = json.dumps({"name": model_id, "stream": True}).encode()
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/pull",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
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
                if status:
                    _emit(on_status, status)
    except Exception as exc:
        log.warning("API pull failed, trying CLI: %s", exc)
        _pull_via_cli(model_id, on_status)

    if not model_installed(base_url, model_id):
        raise RuntimeError(f"Model {model_id} could not be downloaded")
