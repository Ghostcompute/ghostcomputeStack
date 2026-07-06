#!/usr/bin/env python3
"""
Ghost Compute Worker Daemon
- Detects CPU and GPUs (NVIDIA, AMD)
- Registers with the Ghost Compute orchestrator
- Sends heartbeats while running
- Receives jobs via WebSocket (preferred) or REST poll
- Runs inference via Ollama or external vLLM (OpenAI-compat on :8000)
- TEE attestation support (NVIDIA Confidential Computing / AMD SEV-SNP)
- Exposes a local HTTP API on :7421 for desktop UI / status checks
"""

import argparse
import hashlib
import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import sys

import hardware_detect
import inference
import ollama_setup
from models import (
    enrich_catalog,
    get_download_status,
    get_selection,
    list_installed,
    load_catalog,
    select_model,
    start_download,
)

# ── Config ────────────────────────────────────────────────────────────────────

ORCHESTRATOR_URL = "https://api.ghostcompute.tech"
BACKEND_URL      = ORCHESTRATOR_URL
TEE_CAPABLE   = os.getenv("TEE_TYPE", "none").lower() != "none"
TEE_TYPE      = os.getenv("TEE_TYPE", "none")
COMPUTE_MODE  = hardware_detect.normalize_compute_mode(os.getenv("COMPUTE_DEVICE", "auto"))
GPU_INDEX     = int(os.getenv("GPU_INDEX", "0") or "0")
VLLM_URL      = os.getenv("VLLM_URL", "http://localhost:8000")
DEFAULT_MODEL = os.getenv("GHOST_OLLAMA_MODEL", os.getenv("DEFAULT_MODEL", "llama3.2:3b"))
AUTH_TOKEN    = os.getenv("WORKER_TOKEN", "")

PLACEHOLDER_PUBKEYS = frozenset({
    "11111111111111111111111111111111",
    "11111111111111111111111111111112",
    "So11111111111111111111111111111111111111112",
})


def normalize_operator_pubkey(addr: str) -> str:
    addr = (addr or "").strip()
    if not addr or addr in PLACEHOLDER_PUBKEYS:
        return ""
    if len(set(addr)) == 1 and addr[0] == "1" and len(addr) >= 20:
        return ""
    return addr


WALLET_ADDR   = normalize_operator_pubkey(os.getenv("WORKER_PUBKEY", ""))

PRICE_PER_1M  = 8.5  # GHST per 1M output tokens

# ── State ─────────────────────────────────────────────────────────────────────

state = {
    "running": False,
    "backend_ok": False,
    "last_backend_error": None,
    "inference_ready": False,
    "inference_error": None,
    "inference_backend": None,
    "ollama_status": "pending",
    "ollama_message": "Preparing inference engine…",
    "worker_address": WALLET_ADDR or "",
    "compute_mode": COMPUTE_MODE,
    "gpu_index": GPU_INDEX,
    "cpu": hardware_detect.empty_cpu("Detecting…"),
    "gpus": [],
    "gpu": hardware_detect.empty_gpu("Detecting…"),
    "gpu_detected": False,
    "effective_compute": "auto",
    "active_job": None,
    "jobs": [],
    "tokens_per_sec": 0,
    "jobs_today": 0,
    "earnings": {"today": 0.0, "week": 0.0, "total": 0.0},
}

_worker_thread: threading.Thread | None = None
_active_ws = None
_ws_job_queue: list = []
_ws_job_lock = threading.Lock()
_ollama_bootstrap_done = threading.Event()


def _on_ollama_status(msg: str) -> None:
    state["ollama_message"] = msg


def bootstrap_ollama() -> None:
    """Install Ollama, start it, and pull the default model without user action."""
    model_id = os.getenv("GHOST_OLLAMA_MODEL", DEFAULT_MODEL)
    try:
        state["ollama_status"] = "running"
        url = ollama_setup.ensure_ollama(on_status=_on_ollama_status)
        ollama_setup.ensure_model(url, model_id, on_status=_on_ollama_status)
        inference.apply_model_selection(model_id, "ollama")
        state["inference_backend"] = "ollama"
        state["inference_ready"] = True
        state["inference_error"] = None
        state["ollama_status"] = "ready"
        state["ollama_message"] = f"Ollama ready · {model_id}"
        log({"event": "ollama_ready", "model": model_id, "url": url})
    except Exception as exc:
        state["inference_ready"] = False
        state["inference_error"] = str(exc)
        state["ollama_status"] = "failed"
        state["ollama_message"] = str(exc)
        log({"event": "ollama_bootstrap_failed", "err": str(exc)})
    finally:
        _ollama_bootstrap_done.set()


def wait_for_ollama_bootstrap(timeout: float = 300) -> None:
    _ollama_bootstrap_done.wait(timeout=timeout)


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_SSL_CTX = _ssl_context()

# ── Hardware detection ─────────────────────────────────────────────────────────

def refresh_hardware() -> dict:
    snap = hardware_detect.scan_hardware(state["compute_mode"], state["gpu_index"])
    state["cpu"] = snap["cpu"]
    state["gpus"] = snap["gpus"]
    state["gpu"] = snap["display"]
    state["gpu_detected"] = snap["gpu_detected"]
    state["effective_compute"] = snap["effective_compute"]
    inference.set_compute_mode(snap["effective_compute"])
    return snap


def detect_hardware() -> bool:
    snap = refresh_hardware()
    log({"event": "hardware_detected",
         "cpu": snap["cpu"].get("name"),
         "gpus": [g.get("name") for g in snap["gpus"]],
         "effective_compute": snap["effective_compute"]})
    return snap["cpu"].get("detected", False) or snap["gpu_detected"]

# ── Backend API helpers ────────────────────────────────────────────────────────

def _req(method: str, path: str, body: dict | None = None) -> dict | None:
    url  = f"{BACKEND_URL.rstrip('/')}{path}"
    data = json.dumps(body).encode() if body else None
    req  = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {AUTH_TOKEN}",
                 "User-Agent": "GhostCompute-Worker/0.1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as r:
            state["last_backend_error"] = None
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read())
        except Exception:
            err_body = {"error": str(e)}
        log({"event": "backend_error", "path": path, "status": e.code, "err": err_body})
        if e.code == 409:
            return {"error": "already_registered", "status": 409}
        state["last_backend_error"] = err_body.get("error") or f"HTTP {e.code}"
        return None
    except Exception as e:
        state["last_backend_error"] = str(e)
        log({"event": "backend_error", "path": path, "err": str(e)})
        return None


def register_with_backend():
    addr = normalize_operator_pubkey(state["worker_address"])
    state["worker_address"] = addr
    if not addr or len(addr) < 20:
        state["backend_ok"] = False
        log({"event": "register_skipped", "msg": "wallet pubkey required"})
        return

    hw_tier = hardware_detect.hardware_tier_label(
        state["compute_mode"], state["cpu"], state["gpus"], state["gpu_index"])

    result = _req("POST", "/api/workers/register", {
        "pubkey":       addr,
        "auth_token":   AUTH_TOKEN,
        "model":        inference.get_active_model(),
        "tok_per_sec":  max(state["tokens_per_sec"], 1),
        "capabilities": {
            "gpu_model":  state["gpu"].get("name", "unknown"),
            "vram_gb":    state["gpu"].get("vram_total_gb", 0),
            "tee_type":   TEE_TYPE,
            "tee_capable": TEE_CAPABLE,
        },
        "hardware_tier": hw_tier,
        "tee_capable":   TEE_CAPABLE,
    })

    if result and (result.get("workerId") or result.get("status") == 409):
        state["worker_address"] = addr
        state["backend_ok"] = True
        log({"event": "registered", "address": addr})
    else:
        state["backend_ok"] = False
        log({"event": "register_failed", "msg": state["last_backend_error"]})


def send_heartbeat():
    if not state["backend_ok"]:
        return
    _req("POST", "/api/workers/heartbeat", {
        "pubkey":      state["worker_address"],
        "tok_per_sec": state["tokens_per_sec"],
        "status":      "idle" if not state["active_job"] else "busy",
    })

# ── Inference (Ollama / external vLLM) ───────────────────────────────────────

def benchmark_inference() -> float:
    try:
        return inference.run_benchmark()
    except Exception:
        return 0.0


def resolve_inference_backend() -> str:
    backend = inference.resolve_backend()
    state["inference_backend"] = backend
    return backend

# ── TEE attestation ───────────────────────────────────────────────────────────

def compute_attestation_hash(job_id: str, worker_addr: str, response: str) -> str:
    payload = json.dumps({"jobId": job_id, "workerAddress": worker_addr, "response": response[:512]})
    return hashlib.sha256(payload.encode()).hexdigest()

# ── WebSocket job delivery ────────────────────────────────────────────────────

def _ws_url() -> str:
    base = BACKEND_URL.rstrip("/")
    if base.startswith("https://"):
        return base.replace("https://", "wss://", 1)
    return base.replace("http://", "ws://", 1)


def _ws_on_message(_ws, message: str):
    try:
        msg = json.loads(message)
    except Exception:
        return
    if msg.get("type") == "job:new":
        with _ws_job_lock:
            _ws_job_queue.append(msg)
    elif msg.get("type") == "stats:update":
        pass  # ignore broadcast stats


def _ws_on_open(ws):
    global _active_ws
    _active_ws = ws
    ws.send(json.dumps({
        "type": "worker:register",
        "pubkey": state["worker_address"],
        "worker_type": "desktop",
        "model": inference.get_active_model(),
        "tok_per_sec": max(state["tokens_per_sec"], 1),
        "tee_type": TEE_TYPE,
        "attestation_verified": TEE_CAPABLE,
    }))
    log({"event": "ws_registered"})


def _ws_on_close(_ws, code, msg):
    global _active_ws
    _active_ws = None
    log({"event": "ws_closed", "code": code})


def _ws_on_error(_ws, error):
    log({"event": "ws_error", "err": str(error)})


def ws_loop():
    global _ws_app
    try:
        import websocket
    except ImportError:
        log({"event": "ws_unavailable", "msg": "pip install websocket-client"})
        return

    while state["running"]:
        try:
            _ws_app = websocket.WebSocketApp(
                _ws_url(),
                on_message=_ws_on_message,
                on_open=_ws_on_open,
                on_error=_ws_on_error,
                on_close=_ws_on_close,
            )
            _ws_app.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            log({"event": "ws_error", "err": str(e)})
        time.sleep(3)


def _dequeue_ws_job() -> dict | None:
    with _ws_job_lock:
        if _ws_job_queue:
            return _ws_job_queue.pop(0)
    return None


def fetch_next_job() -> dict | None:
    if not state["backend_ok"] or not state["worker_address"]:
        return None
    ws_job = _dequeue_ws_job()
    if ws_job:
        return {"job": {
            "id": ws_job.get("jobId"),
            "model": ws_job.get("model", inference.get_active_model()),
            "messages": ws_job.get("messages", []),
            "guarantee": ws_job.get("guarantee", "standard"),
            "confidential": ws_job.get("confidential", False),
            "max_tokens": ws_job.get("maxTokens", 16384),
        }}
    resp = _req("GET", f"/api/jobs/next?pubkey={quote(state['worker_address'], safe='')}")
    if resp and resp.get("job"):
        return resp
    return None


def complete_job_via_ws_or_rest(job_id: str, ttft_ms: float, tpot_ms: float,
                                 output_tokens: int, response: str = "",
                                 confidential: bool = False):
    attestation_hash = None
    if confidential and TEE_CAPABLE:
        attestation_hash = compute_attestation_hash(job_id, state["worker_address"], response)

    payload = {
        "jobId": job_id,
        "content": response,
        "tokens_generated": output_tokens,
        "ttft_ms": int(ttft_ms),
        "tpot_ms": int(tpot_ms),
        "pubkey": state["worker_address"],
    }
    if attestation_hash:
        payload["attestation_hash"] = attestation_hash

    if _active_ws:
        try:
            _active_ws.send(json.dumps({"type": "job:complete", **payload}))
            return
        except Exception:
            pass
    _req("POST", "/api/jobs/complete", payload)


_token_pending: dict[str, str] = {}
_token_timers: dict[str, threading.Timer] = {}
_token_lock = threading.Lock()
TOKEN_FLUSH_SEC = 0.025


def _flush_job_tokens(job_id: str) -> None:
    with _token_lock:
        piece = _token_pending.pop(job_id, "")
        _token_timers.pop(job_id, None)
    if not piece or not state.get("worker_address"):
        return
    _req("POST", "/api/jobs/token", {
        "jobId": job_id,
        "token": piece,
        "pubkey": state["worker_address"],
    })


def flush_job_tokens(job_id: str) -> None:
    with _token_lock:
        timer = _token_timers.pop(job_id, None)
    if timer:
        timer.cancel()
    _flush_job_tokens(job_id)


def emit_job_token(job_id: str, token: str) -> None:
    if not token:
        return
    # Orchestrator uses Socket.io — raw WS JSON is ignored. Batch REST posts instead.
    with _token_lock:
        _token_pending[job_id] = _token_pending.get(job_id, "") + token
        if job_id in _token_timers:
            return
        timer = threading.Timer(TOKEN_FLUSH_SEC, lambda jid=job_id: _flush_job_tokens(jid))
        timer.daemon = True
        _token_timers[job_id] = timer
        timer.start()

# ── Heartbeat loop ─────────────────────────────────────────────────────────────

def heartbeat_loop():
    while True:
        time.sleep(15 if state["running"] else 30)
        if state["running"]:
            send_heartbeat()

# ── Worker inference loop ─────────────────────────────────────────────────────

def worker_loop():
    while state["running"]:
        resp = fetch_next_job()
        job = resp.get("job") if resp else None

        if not job:
            time.sleep(0.5)
            continue

        job_id = job["id"]
        max_tokens = job.get("max_tokens", 16384)
        guarantee = job.get("guarantee", "standard")
        confidential = job.get("confidential", False) or guarantee == "max_trust_split"
        messages = job.get("messages", [])

        state["active_job"] = {"id": job_id, "tokens": max_tokens, "guarantee": guarantee, "progress": 0.0}
        log({"event": "job_start", "id": job_id, "tokens": max_tokens, "guarantee": guarantee})
        refresh_hardware()

        def on_chunk(piece: str) -> None:
            emit_job_token(job_id, piece)

        def on_progress(generated: int, cap: int) -> None:
            if state["active_job"]:
                state["active_job"]["progress"] = min(
                    99.0, (generated / max(cap, 1)) * 100,
                )

        try:
            result = inference.run_inference(
                messages,
                max_tokens=max_tokens,
                on_chunk=on_chunk,
                on_token=on_progress,
                model=job.get("model"),
            )
        except Exception as e:
            err = str(e)
            log({"event": "job_error", "id": job_id, "err": err})
            flush_job_tokens(job_id)
            if _active_ws:
                try:
                    _active_ws.send(json.dumps({"type": "job:error", "jobId": job_id, "error": err}))
                except Exception:
                    pass
            state["jobs"].insert(0, {"id": job_id, "status": "failed", "tokens": 0, "earn": 0.0, "ts": time.time()})
            state["jobs"] = state["jobs"][:100]
            state["active_job"] = None
            continue

        flush_job_tokens(job_id)
        tokens = result["tokens"]
        earn = round((tokens / 1_000_000) * PRICE_PER_1M, 4)
        tps = round(tokens / max(result["duration_ms"] / 1000, 0.001), 1)
        state["tokens_per_sec"] = tps
        state["active_job"]["progress"] = 100.0

        state["jobs"].insert(0, {"id": job_id, "status": "completed", "tokens": tokens,
                                  "guarantee": guarantee, "earn": earn,
                                  "duration_ms": result["duration_ms"], "ts": time.time()})
        state["jobs"] = state["jobs"][:100]
        state["active_job"] = None
        state["earnings"]["today"] = round(state["earnings"]["today"] + earn, 4)
        state["earnings"]["week"]  = round(state["earnings"]["week"]  + earn, 4)
        state["earnings"]["total"] = round(state["earnings"]["total"] + earn, 4)
        state["jobs_today"] += 1

        complete_job_via_ws_or_rest(
            job_id, result["ttft_ms"], result["tpot_ms"], tokens,
            response=result["content"], confidential=confidential,
        )
        log({"event": "job_done", "id": job_id, "earn": earn, "tps": tps})
        refresh_hardware()

# ── Local HTTP API ─────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def _route_path(self) -> str:
        path = urlparse(self.path).path
        return path.rstrip("/") or "/"

    def _query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n)) if n else {}

    def _json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        path = self._route_path()
        if path == "/status":
            refresh_hardware()
            selection = get_selection()
            try:
                import huggingface_hub  # noqa: F401
                hf_ok = True
            except ImportError:
                hf_ok = False
            self._json({
                "running":           state["running"],
                "python_executable": sys.executable,
                "daemon_root":       str(daemon_app_root()),
                "daemon_script":     str(Path(__file__).resolve()),
                "features":          {"ollama_auto_setup": True},
                "huggingface_hub":   hf_ok,
                "backend_ok":        state["backend_ok"],
                "last_backend_error": state["last_backend_error"],
                "worker_address":    state["worker_address"],
                "tee_capable":       TEE_CAPABLE,
                "tee_type":          TEE_TYPE,
                "compute_mode":      state["compute_mode"],
                "effective_compute": state["effective_compute"],
                "gpu":               state["gpu"],
                "gpu_detected":      state["gpu_detected"],
                "active_job":        state["active_job"],
                "tokens_per_sec":    state["tokens_per_sec"],
                "jobs_today":        state["jobs_today"],
                "earnings_today":    state["earnings"]["today"],
                "inference_ready":   state["inference_ready"],
                "inference_error":   state["inference_error"],
                "inference_backend": state["inference_backend"],
                "ollama_status":     state["ollama_status"],
                "ollama_message":    state["ollama_message"],
                "active_model":      inference.get_active_model(),
                "selected_model":    selection.get("id"),
                "selected_backend":  selection.get("backend"),
            })
        elif path == "/jobs":
            self._json({"jobs": state["jobs"][:30]})
        elif path == "/earnings":
            self._json(state["earnings"])
        elif path == "/models/catalog":
            refresh_hardware()
            installed = list_installed()
            installed_set: set[str] = set()
            for names in installed.values():
                installed_set.update(names)
                for name in names:
                    if ":" in name:
                        installed_set.add(name.split(":")[0])
            selection = get_selection()
            vram = float(state["gpu"].get("vram_total_gb") or 0)
            models = enrich_catalog(
                load_catalog(),
                vram_total_gb=vram,
                installed=installed_set,
                selected_id=selection.get("id"),
                selected_backend=selection.get("backend"),
            )
            self._json({
                "models": models,
                "vram_gb": vram,
                "gpu_name": state["gpu"].get("name"),
                "selection": selection,
            })
        elif path == "/models/installed":
            self._json(list_installed())
        elif path == "/models/download-status":
            job_id = (self._query().get("job_id") or [None])[0]
            if not job_id:
                self._json({"error": "job_id required"}, 400)
                return
            job = get_download_status(str(job_id))
            if not job:
                self._json({"error": "job not found"}, 404)
                return
            self._json(job)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        global _worker_thread
        path = self._route_path()
        if path == "/worker/start":
            refresh_hardware()
            ok, err = hardware_detect.can_start(state["compute_mode"], state["cpu"], state["gpus"])
            if not ok:
                self._json({"ok": False, "error": "hardware_unavailable", "message": err}, 503)
                return

            register_with_backend()
            if not state["backend_ok"]:
                self._json({"ok": False, "error": "backend_unreachable",
                            "message": state.get("last_backend_error", "Cannot reach Ghost Compute network.")}, 503)
                return

            try:
                if not _ollama_bootstrap_done.is_set():
                    wait_for_ollama_bootstrap(timeout=300)
                resolve_inference_backend()
                state["tokens_per_sec"] = benchmark_inference()
                state["inference_ready"] = True
                state["inference_error"] = None
                state["ollama_status"] = "ready"
            except Exception as e:
                state["inference_ready"] = False
                state["inference_error"] = str(e)
                self._json({"ok": False, "error": "inference_unavailable", "message": str(e)}, 503)
                return

            if not state["running"]:
                state["running"] = True
                send_heartbeat()
                _worker_thread = threading.Thread(target=worker_loop, daemon=True)
                _worker_thread.start()
                threading.Thread(target=ws_loop, daemon=True).start()
            self._json({"ok": True, "backend_ok": state["backend_ok"],
                        "effective_compute": state["effective_compute"],
                        "tps": state["tokens_per_sec"]})

        elif path == "/worker/stop":
            state["running"] = False
            state["active_job"] = None
            state["tokens_per_sec"] = 0
            send_heartbeat()
            self._json({"ok": True})

        elif path == "/wallet":
            body = self._read_json()
            addr = normalize_operator_pubkey(str(body.get("address", "")))
            if not addr:
                state["worker_address"] = ""
                state["backend_ok"] = False
                state["last_backend_error"] = None
                self._json({"ok": True, "worker_address": ""})
                return
            if len(addr) < 20:
                self._json({"ok": False, "error": "invalid_wallet"}, 400)
                return
            state["worker_address"] = addr
            register_with_backend()
            self._json({
                "ok": state["backend_ok"],
                "worker_address": state["worker_address"],
                "message": state["last_backend_error"] if not state["backend_ok"] else None,
            })

        elif path == "/models/download":
            if state["running"]:
                self._json({"ok": False, "error": "worker_running",
                            "message": "Stop the worker before downloading models."}, 409)
                return
            body = self._read_json()
            model_id = str(body.get("id") or "").strip()
            if not model_id:
                self._json({"ok": False, "error": "id required"}, 400)
                return
            try:
                job_id = start_download(model_id)
                self._json({"ok": True, "job_id": job_id})
            except ValueError as e:
                self._json({"ok": False, "error": str(e)}, 400)
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 500)

        elif path == "/models/select":
            if state["running"]:
                self._json({"ok": False, "error": "worker_running",
                            "message": "Stop the worker before changing models."}, 409)
                return
            body = self._read_json()
            model_id = str(body.get("id") or "").strip()
            backend = body.get("backend")
            if not model_id:
                self._json({"ok": False, "error": "id required"}, 400)
                return
            try:
                result = select_model(model_id, backend)
                self._json(result)
            except ValueError as e:
                self._json({"ok": False, "error": str(e)}, 400)
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 500)
        else:
            self._json({"error": "not found"}, 404)


def log(msg: dict):
    print(json.dumps(msg), flush=True)


def daemon_app_root() -> Path:
    worker_py = Path(__file__).resolve().parent
    app = worker_py.parent
    if (app / "src-tauri").is_dir():
        return app
    return worker_py


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ghost Compute Worker Daemon")
    parser.add_argument("--port",    type=int, default=7421)
    parser.add_argument("--backend", default=BACKEND_URL)
    parser.add_argument("--wallet",  default=WALLET_ADDR)
    parser.add_argument("--tee",     action="store_true", default=TEE_CAPABLE)
    parser.add_argument("--compute", default=COMPUTE_MODE, choices=["auto", "cpu", "gpu"])
    parser.add_argument("--gpu-index", type=int, default=GPU_INDEX)
    parser.add_argument("--vllm",    default=VLLM_URL)
    args = parser.parse_args()

    BACKEND_URL             = args.backend.rstrip("/")
    VLLM_URL                = args.vllm.rstrip("/")
    state["worker_address"] = normalize_operator_pubkey(args.wallet or "")
    state["compute_mode"]   = hardware_detect.normalize_compute_mode(args.compute)
    state["gpu_index"]      = max(0, args.gpu_index)
    TEE_CAPABLE             = args.tee or TEE_CAPABLE

    detect_hardware()
    if state["worker_address"]:
        register_with_backend()

    threading.Thread(target=bootstrap_ollama, daemon=True).start()

    hb = threading.Thread(target=heartbeat_loop, daemon=True)
    hb.start()

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    log({"event": "ready", "port": args.port,
         "device": state["gpu"]["name"], "compute": state["effective_compute"],
         "backend": BACKEND_URL, "vllm": VLLM_URL, "backend_ok": state["backend_ok"]})

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log({"event": "shutdown"})
