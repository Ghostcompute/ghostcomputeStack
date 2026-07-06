#!/usr/bin/env bash
# Run the Ghost Compute worker on a remote GPU host (e.g. vast.ai).
#
# On the GPU machine:
#   1. Clone/sync the repo
#   2. Copy .env with VLLM_URL=http://127.0.0.1:18000 (or your vLLM port)
#   3. Run this script
#
# From your laptop (optional — only if orchestrator is remote):
#   ssh -L 8000:127.0.0.1:18000 ... for local vLLM testing

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and configure WORKER_TOKEN, WORKER_PUBKEY, ORCHESTRATOR_URL"
  exit 1
fi

echo "[gpu-worker] vLLM health check…"
VLLM_URL="${VLLM_URL:-http://127.0.0.1:8000}"
if ! curl -sf "${VLLM_URL}/health" >/dev/null; then
  echo "vLLM not reachable at ${VLLM_URL}"
  echo "Start vLLM first, or set VLLM_URL in .env"
  exit 1
fi

echo "[gpu-worker] Starting worker → ${ORCHESTRATOR_URL:-http://localhost:3001}"
exec pnpm worker:dev
