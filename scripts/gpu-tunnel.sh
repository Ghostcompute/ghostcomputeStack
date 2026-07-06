#!/usr/bin/env bash
# Forward local vLLM port to a vast.ai (or remote GPU) instance.
#
# Required env:
#   VAST_HOST       — e.g. 219.86.90.205
#   VAST_SSH_PORT   — e.g. 40013
#
# Optional:
#   VAST_KEY        — SSH private key (default: ~/.ssh/id_ed25519_github)
#   LOCAL_VLLM_PORT — local bind port (default: 8000)
#   REMOTE_VLLM_PORT — remote vLLM listen port (default: 18000 on vast)
#
# Example:
#   VAST_HOST=219.86.90.205 VAST_SSH_PORT=40013 bash scripts/gpu-tunnel.sh

set -euo pipefail

HOST="${VAST_HOST:?Set VAST_HOST}"
PORT="${VAST_SSH_PORT:?Set VAST_SSH_PORT}"
KEY="${VAST_KEY:-$HOME/.ssh/id_ed25519_github}"
LOCAL="${LOCAL_VLLM_PORT:-8000}"
REMOTE="${REMOTE_VLLM_PORT:-18000}"

echo "[gpu-tunnel] localhost:${LOCAL} → ${HOST}:127.0.0.1:${REMOTE}"
echo "[gpu-tunnel] Set VLLM_URL=http://localhost:${LOCAL} in .env"

exec ssh -i "$KEY" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -p "$PORT" "root@${HOST}" -L "${LOCAL}:127.0.0.1:${REMOTE}" -N
