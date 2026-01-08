#!/bin/bash
#SBATCH -J forska-docling
#SBATCH -A NAISS2025-22-715 -p alvis
#SBATCH --nodes=1
#SBATCH --gpus-per-node=A100:1    # Only need 1 GPU for Docling
#SBATCH --time=08:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

set -euo pipefail

echo "[docling] starting on host $(hostname) at $(date)"

# Paths
export STACK_ROOT=${STACK_ROOT:-/mimer/NOBACKUP/groups/clin-agent-bench/dev}
mkdir -p "$STACK_ROOT"/{logs,.cache/docling}
cd "$STACK_ROOT"

# Container
SIF_DOCLING="$STACK_ROOT/docling_serve_cu126.sif"
[[ -f "$SIF_DOCLING" ]] || { echo "[docling] missing: $SIF_DOCLING" >&2; exit 2; }

# Logging
LOG_DIR="$STACK_ROOT/logs/${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

# Port
DOCLING_PORT=${DOCLING_PORT:-5001}

# GPU detection
if command -v nvidia-smi &>/dev/null; then
  nvidia-smi --query-gpu=name,memory.total --format=csv
fi

# Cleanup handler
graceful_shutdown() {
  echo "[docling] shutting down..."
  [[ -n "${DOCLING_PID:-}" ]] && kill -TERM "$DOCLING_PID" 2>/dev/null || true
  sleep 2
  [[ -n "${DOCLING_PID:-}" ]] && kill -KILL "$DOCLING_PID" 2>/dev/null || true
}
trap graceful_shutdown EXIT INT TERM USR1

# Start Docling Serve
echo "[docling] starting Docling Serve on :$DOCLING_PORT"

apptainer exec --cleanenv --nv \
  --env DOCLING_SERVE_ARTIFACTS_PATH=/opt/app-root/src/.cache/docling/models \
  --env GUNICORN_TIMEOUT="600" \
  --env DOCLING_SERVE_MAX_SYNC_WAIT="600" \
  --bind "$STACK_ROOT/.cache/docling:/opt/app-root/src/.cache/docling:rw" \
  "$SIF_DOCLING" \
  python -m docling_serve run --host 0.0.0.0 --port "$DOCLING_PORT" --workers 6 \
  >"$LOG_DIR/docling.log" 2>&1 &
DOCLING_PID=$!

# Wait for service to be ready
wait_for_http() {
  local url="$1" timeout="${2:-300}"
  echo "[docling] waiting for $url..."
  for ((i=1; i<=timeout; i+=2)); do
    if curl -sf --connect-timeout 2 --max-time 4 "$url" >/dev/null 2>&1; then
      echo "[docling] ready after ${i}s"
      return 0
    fi
    sleep 2
  done
  echo "[docling] timeout waiting for $url"
  return 1
}

wait_for_http "http://localhost:$DOCLING_PORT/health" 300

echo ""
echo "=============================================="
echo "[docling] Docling Serve ready!"
echo "  Host:     $(hostname)"
echo "  Endpoint: http://$(hostname):$DOCLING_PORT"
echo ""
echo "SSH tunnel from local machine:"
echo "  ssh -N -L $DOCLING_PORT:$(hostname):$DOCLING_PORT alvis2"
echo ""
echo "Test:"
echo "  curl http://localhost:$DOCLING_PORT/health"
echo "=============================================="

# Machine-readable config block for scripts to parse
echo ""
echo "[docling:config:start]"
echo "DOCLING_HOST=$(hostname)"
echo "DOCLING_PORT=$DOCLING_PORT"
echo "[docling:config:end]"

# Keep running
wait
