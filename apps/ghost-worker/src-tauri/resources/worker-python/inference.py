"""Local inference via Ollama or vLLM OpenAI-compatible API (external servers)."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Callable

import ollama_setup

OLLAMA_MODEL = os.getenv("GHOST_OLLAMA_MODEL", "llama3.2:3b")
VLLM_BASE_URL = os.getenv("GHOST_VLLM_URL", os.getenv("VLLM_URL", "http://127.0.0.1:8000")).rstrip("/")
if not VLLM_BASE_URL.endswith("/v1"):
    VLLM_BASE_URL = f"{VLLM_BASE_URL}/v1"
VLLM_MODEL = os.getenv("GHOST_VLLM_MODEL", os.getenv("DEFAULT_MODEL", "llama3.2:3b"))
MAX_OUTPUT_TOKENS = int(os.getenv("GHOST_MAX_TOKENS", "512"))
INFERENCE_PREF = os.getenv("GHOST_INFERENCE", "ollama")

_ollama_url = (os.getenv("GHOST_OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/")
_active_backend: str | None = None
_active_model: str | None = None
_compute_mode: str = "auto"
_runtime_ollama_model: str | None = None
_runtime_vllm_model: str | None = None


def set_compute_mode(mode: str) -> None:
    global _compute_mode
    m = (mode or "auto").strip().lower()
    _compute_mode = m if m in ("auto", "cpu", "gpu") else "auto"


def get_compute_mode() -> str:
    return _compute_mode


def get_ollama_model() -> str:
    return _runtime_ollama_model or OLLAMA_MODEL


def get_vllm_model() -> str:
    return _runtime_vllm_model or VLLM_MODEL


def apply_model_selection(model_id: str, backend: str) -> None:
    """Apply a catalog selection to runtime inference state."""
    global _runtime_ollama_model, _runtime_vllm_model, _active_model, _active_backend
    if backend == "ollama":
        _runtime_ollama_model = model_id
        os.environ["GHOST_OLLAMA_MODEL"] = model_id
        os.environ["GHOST_INFERENCE"] = "ollama"
    elif backend == "vllm":
        _runtime_vllm_model = model_id
        os.environ["DEFAULT_MODEL"] = model_id
        os.environ["GHOST_VLLM_MODEL"] = model_id
        os.environ["GHOST_INFERENCE"] = "vllm"
    if _active_backend == backend:
        _active_model = model_id


def get_active_backend() -> str | None:
    return _active_backend


def get_active_model() -> str:
    if _active_model:
        return _active_model
    if _active_backend == "ollama":
        return get_ollama_model()
    if _active_backend == "vllm":
        return get_vllm_model()
    return get_ollama_model()


def _ollama_num_gpu() -> int:
    if _compute_mode == "cpu":
        return 0
    return -1


def _check_vllm() -> bool:
    try:
        req = urllib.request.Request(f"{VLLM_BASE_URL}/models")
        with urllib.request.urlopen(req, timeout=5):
            return True
    except Exception:
        return False


def _vllm_unavailable_message() -> str:
    return (
        f"vLLM not reachable at {VLLM_BASE_URL}. "
        f"Run: pnpm ghost-worker:prepare:vllm then restart Ghost Worker, "
        f"or start: vllm serve {get_vllm_model()} --port 8000"
    )


def _ensure_ollama_backend() -> str:
    global _ollama_url
    url = ollama_setup.ensure_ollama(on_status=lambda msg: None)
    _ollama_url = url
    return url


def resolve_backend() -> str:
    global _active_backend, _active_model, _ollama_url
    pref = (os.getenv("GHOST_INFERENCE") or INFERENCE_PREF or "auto").lower()

    if pref == "vllm":
        if not _check_vllm():
            raise RuntimeError(_vllm_unavailable_message())
        _active_backend = "vllm"
        _active_model = get_vllm_model()
        return _active_backend

    if pref in ("ollama", "auto"):
        _ensure_ollama_backend()
        model_id = get_ollama_model()
        try:
            ollama_setup.ensure_model(_ollama_url, model_id)
        except Exception as exc:
            raise RuntimeError(
                f"Ollama is running but model {model_id} could not be pulled: {exc}"
            ) from exc
        _active_backend = "ollama"
        _active_model = model_id
        return _active_backend

    raise RuntimeError(f"Unknown inference backend: {pref}")


def run_benchmark() -> float:
    result = run_inference([{"role": "user", "content": "Say hi in one word."}], max_tokens=32)
    elapsed = max(result["duration_ms"] / 1000, 0.001)
    return round(result["tokens"] / elapsed, 1)


def run_inference(
    messages: list[dict],
    max_tokens: int = MAX_OUTPUT_TOKENS,
    on_token: Callable[[int, int], None] | None = None,
    on_chunk: Callable[[str], None] | None = None,
    model: str | None = None,
) -> dict:
    if not _active_backend:
        resolve_backend()
    if _active_backend == "ollama":
        return _run_ollama(messages, max_tokens, on_token, on_chunk, model=model)
    return _run_vllm(messages, max_tokens, on_token, on_chunk, model=model)


def _run_ollama(
    messages: list[dict],
    max_tokens: int,
    on_token: Callable[[int, int], None] | None,
    on_chunk: Callable[[str], None] | None,
    model: str | None = None,
) -> dict:
    start = time.time()
    first_at: float | None = None
    content = ""
    tokens = 0
    model_id = model or get_ollama_model()

    payload = json.dumps({
        "model": model_id,
        "messages": messages,
        "stream": True,
        "options": {
            "num_predict": max_tokens,
            "num_gpu": _ollama_num_gpu(),
        },
    }).encode()

    req = urllib.request.Request(
        f"{_ollama_url}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=300) as resp:
        while True:
            line = resp.readline()
            if not line:
                break
            try:
                chunk = json.loads(line.decode())
            except json.JSONDecodeError:
                continue
            piece = (chunk.get("message") or {}).get("content") or ""
            if not piece:
                continue
            if first_at is None:
                first_at = time.time()
            content += piece
            tokens += 1
            if on_chunk:
                on_chunk(piece)
            if on_token:
                on_token(tokens, max_tokens)

    end = time.time()
    ttft_ms = int(((first_at or end) - start) * 1000)
    out_tokens = max(tokens, 1)
    tpot_ms = int(((end - (first_at or end)) / max(out_tokens - 1, 1)) * 1000) if out_tokens > 1 else 0

    return {
        "content": content.strip() or "(empty)",
        "tokens": out_tokens,
        "ttft_ms": ttft_ms,
        "tpot_ms": tpot_ms,
        "duration_ms": int((end - start) * 1000),
    }


def _run_vllm(
    messages: list[dict],
    max_tokens: int,
    on_token: Callable[[int, int], None] | None,
    on_chunk: Callable[[str], None] | None,
    model: str | None = None,
) -> dict:
    start = time.time()
    first_at: float | None = None
    content = ""
    tokens = 0
    model_id = model or get_vllm_model()

    payload = json.dumps({
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.7,
        "stream": True,
    }).encode()

    req = urllib.request.Request(
        f"{VLLM_BASE_URL}/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=300) as resp:
        while True:
            line = resp.readline()
            if not line:
                break
            text = line.decode().strip()
            if not text.startswith("data:"):
                continue
            raw = text[5:].strip()
            if raw == "[DONE]":
                break
            try:
                chunk = json.loads(raw)
            except json.JSONDecodeError:
                continue
            piece = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content") or ""
            if not piece:
                continue
            if first_at is None:
                first_at = time.time()
            content += piece
            tokens += 1
            if on_chunk:
                on_chunk(piece)
            if on_token:
                on_token(tokens, max_tokens)

    end = time.time()
    ttft_ms = int(((first_at or end) - start) * 1000)
    out_tokens = max(tokens, 1)
    tpot_ms = int(((end - (first_at or end)) / max(out_tokens - 1, 1)) * 1000) if out_tokens > 1 else 0

    return {
        "content": content.strip() or "(empty)",
        "tokens": out_tokens,
        "ttft_ms": ttft_ms,
        "tpot_ms": tpot_ms,
        "duration_ms": int((end - start) * 1000),
    }
