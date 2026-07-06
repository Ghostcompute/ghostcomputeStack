#!/usr/bin/env python3
"""
Ghost Compute Worker Daemon
- Detects CPU and GPUs (NVIDIA, AMD)
- Registers with the Ghost Compute orchestrator
- Sends heartbeats while running
- Receives jobs via WebSocket (preferred) or REST poll
- Runs inference via vLLM (OpenAI-compat API on :8000)
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
from urllib.parse import quote

import hardware_detect

# ── Config ────────────────────────────────────────────────────────────────────

BACKEND_URL   = os.getenv("GHOST_ORCHESTRATOR_URL", "http://localhost:3001")
WALLET_ADDR   = os.getenv("WORKER_PUBKEY", "")
TEE_CAPABLE   = os.getenv("TEE_TYPE", "none").lower() != "none"
TEE_TYPE      = os.getenv("TEE_TYPE", "none")
COMPUTE_MODE  = hardware_detect.normalize_compute_mode(os.getenv("COMPUTE_DEVICE", "auto"))
GPU_INDEX     = int(os.getenv("GPU_INDEX", "0") or "0")
VLLM_URL      = os.getenv("VLLM_URL", "http://localhost:8000")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "meta-llama/Llama-3.1-8B-Instruct")
AUTH_TOKEN    = os.getenv("WORKER_TOKEN", "")

# Orchestrator sets inference pricing — daemon fetches /api/pricing.
DEFAULT_GHST_PER_OUTPUT_TOKEN = 1.0

# ── State ─────────────────────────────────────────────────────────────────────

state = {
    "running": False,
    "backend_ok": False,
    "last_backend_error": None,
    "inference_ready": False,
    "inference_error": None,
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
    "ghst_per_output_token": DEFAULT_GHST_PER_OUTPUT_TOKEN,
}

_worker_thread: threading.Thread | None = None
_active_ws = None
_ws_job_queue: list = []
_ws_job_lock = threading.Lock()


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


def refresh_pricing_from_backend() -> None:
    result = _req("GET", "/api/pricing")
    if not result:
        return
    try:
        rate = float(result.get("ghstPerOutputToken", DEFAULT_GHST_PER_OUTPUT_TOKEN))
        if rate > 0:
            state["ghst_per_output_token"] = rate
    except (TypeError, ValueError):
        pass


def earn_ghst(tokens: int) -> float:
    rate = float(state.get("ghst_per_output_token") or DEFAULT_GHST_PER_OUTPUT_TOKEN)
    return round(tokens * rate, 4)


def register_with_backend():
    addr = (state["worker_address"] or "").strip()
    if not addr or len(addr) < 20:
        state["backend_ok"] = False
        log({"event": "register_skipped", "msg": "wallet pubkey required"})
        return

    hw_tier = hardware_detect.hardware_tier_label(
        state["compute_mode"], state["cpu"], state["gpus"], state["gpu_index"])

    result = _req("POST", "/api/workers/register", {
        "pubkey":       addr,
        "auth_token":   AUTH_TOKEN,
        "model":        DEFAULT_MODEL,
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
        refresh_pricing_from_backend()
        log({"event": "registered", "address": addr})
    else:
        state["backend_ok"] = False
        log({"event": "register_failed", "msg": state["last_backend_error"]})


def send_heartbeat():
    if not state["backend_ok"]:
        return
    refresh_pricing_from_backend()
    _req("POST", "/api/workers/heartbeat", {
        "pubkey":      state["worker_address"],
        "tok_per_sec": state["tokens_per_sec"],
        "status":      "idle" if not state["active_job"] else "busy",
    })

# ── vLLM inference ────────────────────────────────────────────────────────────

def _vllm_chat(messages: list, max_tokens: int = 16384, confidential: bool = False) -> dict:
    """Call vLLM's OpenAI-compat endpoint — returns {content, tokens, ttft_ms, tpot_ms, duration_ms}"""
    import urllib.parse
    url = f"{VLLM_URL}/v1/chat/completions"
    body = json.dumps({
        "model": DEFAULT_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
    }).encode()

    req = urllib.request.Request(url, data=body, method="POST",
                                  headers={"Content-Type": "application/json"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=120, context=_ssl_context()) as r:
            t1 = time.monotonic()
            resp = json.loads(r.read())
    except Exception as e:
        raise RuntimeError(f"vLLM error: {e}") from e

    choice = resp["choices"][0]
    content = choice["message"]["content"]
    usage = resp.get("usage", {})
    total_tokens = usage.get("completion_tokens", len(content.split()))
    duration_ms = round((t1 - t0) * 1000)
    ttft_ms = duration_ms  # approximate (non-streaming)
    tpot_ms = round(duration_ms / max(total_tokens, 1))
    return {
        "content": content, "tokens": total_tokens,
        "ttft_ms": ttft_ms, "tpot_ms": tpot_ms, "duration_ms": duration_ms,
    }


def benchmark_vllm() -> float:
    """Return tokens/sec from a quick warmup inference."""
    try:
        messages = [{"role": "user", "content": "Count to 20."}]
        result = _vllm_chat(messages, max_tokens=80)
        tps = round(result["tokens"] / max(result["duration_ms"] / 1000, 0.001), 1)
        return tps
    except Exception:
        return 0.0


def resolve_inference_backend() -> str:
    try:
        req = urllib.request.Request(f"{VLLM_URL}/health", method="GET")
        with urllib.request.urlopen(req, timeout=5) as r:
            if r.status == 200:
                return "vllm"
    except Exception:
        pass
    raise RuntimeError(f"vLLM not reachable at {VLLM_URL}")

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
        "model": DEFAULT_MODEL,
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
            "model": ws_job.get("model", DEFAULT_MODEL),
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

        try:
            result = _vllm_chat(messages, max_tokens=max_tokens, confidential=confidential)
        except Exception as e:
            err = str(e)
            log({"event": "job_error", "id": job_id, "err": err})
            if _active_ws:
                try:
                    _active_ws.send(json.dumps({"type": "job:error", "jobId": job_id, "error": err}))
                except Exception:
                    pass
            state["jobs"].insert(0, {"id": job_id, "status": "failed", "tokens": 0, "earn": 0.0, "ts": time.time()})
            state["jobs"] = state["jobs"][:100]
            state["active_job"] = None
            continue

        tokens = result["tokens"]
        earn = earn_ghst(tokens)
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

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n)) if n else {}

    def _json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/status":
            self._json({
                "running":           state["running"],
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
            })
        elif self.path == "/jobs":
            self._json({"jobs": state["jobs"][:30]})
        elif self.path == "/earnings":
            self._json(state["earnings"])
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        global _worker_thread
        if self.path == "/worker/start":
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
                resolve_inference_backend()
                state["tokens_per_sec"] = benchmark_vllm()
                state["inference_ready"] = True
                state["inference_error"] = None
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

        elif self.path == "/worker/stop":
            state["running"] = False
            state["active_job"] = None
            state["tokens_per_sec"] = 0
            send_heartbeat()
            self._json({"ok": True})

        elif self.path == "/wallet":
            body = self._read_json()
            addr = str(body.get("address", "")).strip()
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
        else:
            self._json({"error": "not found"}, 404)


def log(msg: dict):
    print(json.dumps(msg), flush=True)


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
    state["worker_address"] = args.wallet or ""
    state["compute_mode"]   = hardware_detect.normalize_compute_mode(args.compute)
    state["gpu_index"]      = max(0, args.gpu_index)
    TEE_CAPABLE             = args.tee or TEE_CAPABLE

    detect_hardware()
    if state["worker_address"]:
        register_with_backend()

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
