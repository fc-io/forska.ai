#!/bin/bash
#SBATCH -J forska-mn5-sglang
#SBATCH -A ehpc482
#SBATCH --qos=acc_ehpc
#SBATCH --nodes=1
#SBATCH --gres=gpu:4
#SBATCH --time=08:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

# MareNostrum 5 SGLang inference server
# This runs ONLY SGLang (no Postgres/API/App) - connect via SSH tunnel
# Submit: sbatch --export=ALL forska-mn5-sglang.sbatch
# Multi-node: sbatch -N 2 --export=ALL forska-mn5-sglang.sbatch

set -euo pipefail

echo "[mn5] starting on $(hostname) at $(date)"

# Paths
export STACK_ROOT=${STACK_ROOT:-/gpfs/projects/ehpc482/dev}
mkdir -p "$STACK_ROOT"/{hf_cache,logs,.cache,.cache/sglang,tmp}

export HF_HOME=$STACK_ROOT/hf_cache
export XDG_CACHE_HOME=$STACK_ROOT/.cache
export SGLANG_CACHE_DIR=$STACK_ROOT/.cache/sglang
export TMPDIR=$STACK_ROOT/tmp

# Load modules
module load apptainer 2>/dev/null || module load singularity 2>/dev/null || true

# HuggingFace token (optional)
HF_TOKEN_FILE=$STACK_ROOT/.secrets/hf_token.txt
if [[ -f "$HF_TOKEN_FILE" ]]; then
  export HF_TOKEN=$(<"$HF_TOKEN_FILE")
  export HUGGINGFACE_HUB_TOKEN=$HF_TOKEN
  echo "[mn5] loaded HF token"
fi

# Container
SIF_SGLANG="$STACK_ROOT/sglang_latest.sif"
[[ -f "$SIF_SGLANG" ]] || { echo "[mn5] missing: $SIF_SGLANG" >&2; exit 2; }

# Logging
LOG_DIR="$STACK_ROOT/logs/${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

# Cluster topology
NODELIST=${SLURM_JOB_NODELIST:-$(hostname -s)}
mapfile -t HOSTS < <(scontrol show hostnames "$NODELIST" 2>/dev/null || echo "$(hostname -s)")
NNODES=${#HOSTS[@]}
GPUS_PER_NODE=${SLURM_GPUS_ON_NODE:-4}
HEAD_NODE=${HOSTS[0]}

# Get head IP
HEAD_IP=$(getent ahostsv4 "$HEAD_NODE" 2>/dev/null | awk '{print $1; exit}')
[[ -z "$HEAD_IP" ]] && HEAD_IP=$(hostname -I | awk '{print $1}')
echo "[mn5] HEAD_NODE=$HEAD_NODE HEAD_IP=$HEAD_IP"

# SGLang config
export SGLANG_MODEL=${SGLANG_MODEL:-Qwen/Qwen3-30B-A3B-Instruct-2507}
export SGLANG_PORT=${SGLANG_PORT:-30000}
export SGLANG_WORKER_PORT_BASE=$((SGLANG_PORT + 1))
export SGLANG_MAX_RUNNING_REQUESTS=${SGLANG_MAX_RUNNING_REQUESTS:-400}
export SGLANG_MEM_FRACTION=${SGLANG_MEM_FRACTION:-0.92}
export SGLANG_SCHEDULE_POLICY=${SGLANG_SCHEDULE_POLICY:-lpm}
export SGLANG_CHUNKED_PREFILL_SIZE=${SGLANG_CHUNKED_PREFILL_SIZE:-16384}
export SGLANG_ROUTER_POLICY=${SGLANG_ROUTER_POLICY:-round_robin}

echo "[mn5] model=$SGLANG_MODEL nodes=$NNODES gpus/node=$GPUS_PER_NODE"

# GPU detection
if command -v nvidia-smi &>/dev/null; then
  nvidia-smi --query-gpu=name,memory.total --format=csv
fi

# Cleanup handler
graceful_shutdown() {
  echo "[mn5] shutting down..."
  [[ -n "${SGLANG_ROUTER_PID:-}" ]] && kill -TERM "$SGLANG_ROUTER_PID" 2>/dev/null || true
  [[ -n "${SGLANG_SRUN_PID:-}" ]] && kill -TERM "$SGLANG_SRUN_PID" 2>/dev/null || true
  jobs -pr | xargs -r kill -TERM 2>/dev/null || true
  sleep 2
  jobs -pr | xargs -r kill -KILL 2>/dev/null || true
}
trap graceful_shutdown EXIT INT TERM USR1

# Wait for HTTP endpoint
wait_for_http() {
  local url="$1" timeout="${2:-600}" pid="${3:-}"
  for ((i=1; i<=timeout/2; i++)); do
    curl -sf "$url" >/dev/null && { echo "[mn5] $url ready"; return 0; }
    [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null && return 1
    sleep 2
  done
  return 1
}

# Start one SGLang worker per GPU
echo "[mn5] starting $((NNODES * GPUS_PER_NODE)) SGLang workers (1 per GPU, tp=1)"

WORKER_SCRIPT="$STACK_ROOT/.cache/sglang/worker-${SLURM_JOB_ID:-0}.sh"
cat > "$WORKER_SCRIPT" << 'WORKER'
#!/bin/bash
set -euo pipefail
IDX=${SLURM_LOCALID:-0}
PORT=$((SGLANG_WORKER_PORT_BASE + IDX))
exec apptainer exec --cleanenv --nv \
  --env HF_HOME=/hf --env HUGGINGFACE_HUB_CACHE=/hf \
  --env HF_TOKEN="${HF_TOKEN:-}" --env HUGGINGFACE_HUB_TOKEN="${HUGGINGFACE_HUB_TOKEN:-}" \
  --bind "$HF_HOME:/hf:rw" \
  --env SGLANG_CACHE_DIR=/sg --bind "$SGLANG_CACHE_DIR:/sg:rw" \
  "$SIF_SGLANG" \
  python -m sglang.launch_server \
    --model-path "$SGLANG_MODEL" \
    --host 0.0.0.0 --port "$PORT" \
    --tensor-parallel-size 1 --data-parallel-size 1 \
    --max-running-requests "$SGLANG_MAX_RUNNING_REQUESTS" \
    --chunked-prefill-size "$SGLANG_CHUNKED_PREFILL_SIZE" \
    --mem-fraction-static "$SGLANG_MEM_FRACTION" \
    --schedule-policy "$SGLANG_SCHEDULE_POLICY" \
    --enable-metrics --download-dir /hf
WORKER
chmod +x "$WORKER_SCRIPT"
sync

# Launch workers via srun
NODELIST_CSV=$(printf "%s," "${HOSTS[@]}" | sed 's/,$//')
srun --nodes="$NNODES" --ntasks-per-node="$GPUS_PER_NODE" \
  --gpus-per-task=1 --gpu-bind=single:1 \
  --nodelist="$NODELIST_CSV" --export=ALL \
  --output "$LOG_DIR/sglang-%N-%t.log" \
  bash -lc "$WORKER_SCRIPT" &
SGLANG_SRUN_PID=$!

# Wait for first worker
wait_for_http "http://localhost:$SGLANG_WORKER_PORT_BASE/v1/models" 1200 "$SGLANG_SRUN_PID"

# Build worker URLs for router
WORKER_URLS=()
for host in "${HOSTS[@]}"; do
  for ((g=0; g<GPUS_PER_NODE; g++)); do
    if [[ "$host" == "$HEAD_NODE" ]]; then
      WORKER_URLS+=("http://127.0.0.1:$((SGLANG_WORKER_PORT_BASE + g))")
    else
      WORKER_URLS+=("http://${host}:$((SGLANG_WORKER_PORT_BASE + g))")
    fi
  done
done
echo "[mn5] router workers: ${WORKER_URLS[*]}"

# Start router
echo "[mn5] starting router on :$SGLANG_PORT"
apptainer exec --cleanenv "$SIF_SGLANG" \
  python -m sglang_router.launch_router \
    --host 0.0.0.0 --port "$SGLANG_PORT" \
    --policy "$SGLANG_ROUTER_POLICY" \
    --worker-urls "${WORKER_URLS[@]}" \
  >"$LOG_DIR/sglang-router.log" 2>&1 &
SGLANG_ROUTER_PID=$!

wait_for_http "http://localhost:$SGLANG_PORT/v1/models" 120 "$SGLANG_ROUTER_PID"

# Print connection info
echo ""
echo "=============================================="
echo "[mn5] SGLang ready!"
echo "  Host:     $(hostname)"
echo "  Endpoint: http://$(hostname):$SGLANG_PORT/v1"
echo "  Workers:  $((NNODES * GPUS_PER_NODE))"
echo "  Model:    $SGLANG_MODEL"
echo ""
echo "SSH tunnel from local machine:"
echo "  ssh -N -L $SGLANG_PORT:$(hostname):$SGLANG_PORT alog"
echo ""
echo "Test:"
echo "  curl http://localhost:$SGLANG_PORT/v1/models"
echo "=============================================="

# Keep running
wait
