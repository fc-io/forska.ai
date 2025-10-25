#!/bin/bash
#SBATCH -J forska-stack
#SBATCH -A NAISS2025-22-715 -p alvis
#SBATCH --nodes=2
#SBATCH --ntasks=1
# Request 4 A100 GPUs per node (2 nodes total)
# Adjust for your cluster if it uses --gres instead
#SBATCH --gpus-per-node=A100:4
#SBATCH --time=01:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
# Send an early warning signal 2 minutes before time limit
# so we can shut down services cleanly
#SBATCH --signal=B:USR1@120

set -euo pipefail

echo "[forska] starting on host $(hostname) at $(date)"

# Optional, if your cluster uses environment modules
# module purge
# module load apptainer

# Shared root and caches (see README.md)
export STACK_ROOT=${STACK_ROOT:-$PWD}
mkdir -p "$STACK_ROOT"/{pgdata,models,hf_cache,logs,.cache,.secrets}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$STACK_ROOT/.cache}
export VLLM_CACHE_ROOT=${VLLM_CACHE_ROOT:-$XDG_CACHE_HOME/vllm}
export TORCHINDUCTOR_CACHE_DIR=${TORCHINDUCTOR_CACHE_DIR:-$VLLM_CACHE_ROOT/torchinductor}
export TRITON_CACHE_DIR=${TRITON_CACHE_DIR:-$VLLM_CACHE_ROOT/triton}
export HF_HOME=${HF_HOME:-$STACK_ROOT/hf_cache}

# Service ports (host networking)
export POSTGRES_PORT=${POSTGRES_PORT:-5432}
export API_SERVER_PORT=${API_SERVER_PORT:-3001}
export PROD_SERVER=${PROD_SERVER:-8181}

# vLLM runtime knobs (aligned with your interactive config)
# Default to a dummy key when not provided
export VLLM_API_KEY=${VLLM_API_KEY:-fake_key}
export VLLM_GPU_UTIL=${VLLM_GPU_UTIL:-0.90}
# GPU shape overrides used to compute DP/TP; Slurm allocation must match
# Autodetect GPUs per node from Slurm if available; override via --export GPUS_PER_NODE=<n>
export GPUS_PER_NODE=${GPUS_PER_NODE:-${SLURM_GPUS_ON_NODE:-4}}
# Do NOT pin CUDA_VISIBLE_DEVICES when using Ray + multi-node
# Ray/vLLM will respect Slurm cgroups; leaving all allocated GPUs visible per node

# NCCL tuning hints (override via --export as needed)
export NCCL_DEBUG=${NCCL_DEBUG:-WARN}
export NCCL_ASYNC_ERROR_HANDLING=${NCCL_ASYNC_ERROR_HANDLING:-1}
# If your cluster requires a specific NIC/Infiniband device, uncomment and set:
# export NCCL_SOCKET_IFNAME=${NCCL_SOCKET_IFNAME:-ib0}
# export NCCL_IB_HCA=${NCCL_IB_HCA:-mlx5_0}
# export NCCL_IB_GID_INDEX=${NCCL_IB_GID_INDEX:-3}

# Client/API URLs used by the compiled servers
export VITE_LLM_SERVER_URL=${VITE_LLM_SERVER_URL:-http://localhost:8000/v1}
export VITE_SERVER_API=${VITE_SERVER_API:-http://localhost:${API_SERVER_PORT}}
export VITE_PORT=${VITE_PORT:-8181}

SIF_DB="$STACK_ROOT/postgres_18.sif"
SIF_VLLM="$STACK_ROOT/vllm-openai_latest.sif"
SIF_API="$STACK_ROOT/api_server.sif"
SIF_APP="$STACK_ROOT/app_server.sif"

DB_PW_FILE="$STACK_ROOT/.secrets/db_password.txt"
DB_URL_FILE="$STACK_ROOT/.secrets/database_url.txt"
BA_SECRET_FILE="$STACK_ROOT/.secrets/better_auth_secret.txt"
BA_URL_FILE="$STACK_ROOT/.secrets/better_auth_url.txt"

# Preflight
need() { [ -f "$1" ] || { echo "[forska] missing: $1" >&2; exit 2; }; }
need "$SIF_DB"; need "$SIF_VLLM"; need "$SIF_API"; need "$SIF_APP"; need "$DB_PW_FILE"; need "$DB_URL_FILE"

LOG_DIR="$STACK_ROOT/logs/${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

# Multi-node/Ray topology
NNODES=${NNODES:-${SLURM_NNODES:-1}}
HOSTS=( $(scontrol show hostnames "${SLURM_NODELIST:-$(hostname -s)}") )
HEAD_NODE=${HOSTS[0]:-$(hostname -s)}
THIS_NODE=$(hostname -s)
WORKER_NODES=( "${HOSTS[@]:1}" )
RAY_PORT=${RAY_PORT:-6379}
RAY_DASHBOARD_PORT=${RAY_DASHBOARD_PORT:-8265}
RAY_TMP_DIR=${RAY_TMP_DIR:-$STACK_ROOT/.cache/ray}

# Compute distributed sizes: default to TP=2 (pair GPUs) and DP=TOT/TP
TOTAL_GPUS=$(( NNODES * GPUS_PER_NODE ))
DEFAULT_TP=$(( TOTAL_GPUS >= 2 ? 2 : 1 ))
TP_SIZE=${TP_SIZE:-$DEFAULT_TP}
DP_SIZE=${DP_SIZE:-$(( TOTAL_GPUS / TP_SIZE ))}
if (( TOTAL_GPUS % TP_SIZE != 0 )); then
  echo "[forska] warning: total GPUs ($TOTAL_GPUS) not divisible by TP_SIZE ($TP_SIZE); adjusting to TP=$TOTAL_GPUS, DP=1" >&2
  TP_SIZE=$TOTAL_GPUS
  DP_SIZE=1
fi

graceful_shutdown() {
  local reason="${1:-cleanup}"
  echo "[forska] shutting down ($reason)..."
  # Ask all backgrounded apptainer processes to exit
  jobs -pr | xargs -r kill -TERM || true
  # Give them a moment to flush and exit
  for ((i=0; i<20; i++)); do
    [[ -z "$(jobs -pr)" ]] && break
    sleep 1
  done
  # Force kill anything that didn't exit in time
  if [[ -n "$(jobs -pr)" ]]; then
    jobs -pr | xargs -r kill -KILL || true
  fi
  # Stop Ray cluster (head + workers) if started
  if [[ ${NNODES:-1} -gt 1 ]]; then
    echo "[forska] stopping ray on head ${HEAD_NODE}"
    apptainer exec --cleanenv --nv "$SIF_VLLM" ray stop >/dev/null 2>&1 || true
    if [[ ${#WORKER_NODES[@]} -gt 0 ]]; then
      echo "[forska] stopping ray on workers: ${WORKER_NODES[*]}"
      srun --ntasks=$((NNODES-1)) --nodes=$((NNODES-1)) --nodelist="$(printf "%s," "${WORKER_NODES[@]}" | sed 's/,$//')" \
        bash -lc "apptainer exec --cleanenv --nv '$SIF_VLLM' ray stop >/dev/null 2>&1 || true" \
        >/dev/null 2>&1 || true
    fi
  fi
}
trap 'graceful_shutdown EXIT' EXIT
trap 'graceful_shutdown SIGNAL' INT TERM
trap 'graceful_shutdown TIME_LIMIT' USR1

echo "[forska] logs -> $LOG_DIR"

echo "[forska] starting postgres on :$POSTGRES_PORT"
apptainer run --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=${DB_USER:-postgres} \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=${DB_NAME:-postgres} \
  --bind "$STACK_ROOT/pgdata:/var/lib/postgresql" \
  --bind "$DB_PW_FILE:/run/secrets/db_password:ro" \
  "$SIF_DB" \
  >"$LOG_DIR/db.log" 2>&1 &

############################################
# Start Ray (multi-node) + vLLM on the head
############################################

if [[ $NNODES -gt 1 ]]; then
  echo "[forska] starting ray cluster across $NNODES nodes (head=$HEAD_NODE, workers=${WORKER_NODES:-none})"
  mkdir -p "$RAY_TMP_DIR"
  # Start Ray head on this node (the batch script runs on the head)
  apptainer exec --cleanenv --nv \
    --env NCCL_DEBUG="$NCCL_DEBUG" \
    --env NCCL_ASYNC_ERROR_HANDLING="$NCCL_ASYNC_ERROR_HANDLING" \
    ${NCCL_SOCKET_IFNAME:+--env NCCL_SOCKET_IFNAME="$NCCL_SOCKET_IFNAME"} \
    ${NCCL_IB_HCA:+--env NCCL_IB_HCA="$NCCL_IB_HCA"} \
    ${NCCL_IB_GID_INDEX:+--env NCCL_IB_GID_INDEX="$NCCL_IB_GID_INDEX"} \
    --bind "$RAY_TMP_DIR:$RAY_TMP_DIR" \
    "$SIF_VLLM" \
    ray start --head \
      --port "$RAY_PORT" \
      --dashboard-host 0.0.0.0 \
      --dashboard-port "$RAY_DASHBOARD_PORT" \
      --temp-dir "$RAY_TMP_DIR" \
    >"$LOG_DIR/ray-head.log" 2>&1 || { echo "[forska] ray head failed" >&2; exit 2; }

  # Start Ray workers on the remaining nodes
  if [[ ${#WORKER_NODES[@]} -gt 0 ]]; then
    srun --nodes=$((NNODES-1)) --ntasks=$((NNODES-1)) \
      --nodelist="$(printf "%s," "${WORKER_NODES[@]}" | sed 's/,$//')" \
      --output "$LOG_DIR/ray-worker-%h.log" \
      bash -lc "mkdir -p '$RAY_TMP_DIR' && apptainer exec --cleanenv --nv --env NCCL_DEBUG='$NCCL_DEBUG' --env NCCL_ASYNC_ERROR_HANDLING='$NCCL_ASYNC_ERROR_HANDLING' ${NCCL_SOCKET_IFNAME:+--env NCCL_SOCKET_IFNAME='$NCCL_SOCKET_IFNAME'} ${NCCL_IB_HCA:+--env NCCL_IB_HCA='$NCCL_IB_HCA'} ${NCCL_IB_GID_INDEX:+--env NCCL_IB_GID_INDEX='$NCCL_IB_GID_INDEX'} '$SIF_VLLM' ray start --address '${HEAD_NODE}:${RAY_PORT}' --temp-dir '$RAY_TMP_DIR'" || {
        echo "[forska] ray workers failed" >&2; exit 2;
      }
  fi

  # Give Ray a moment to settle
  sleep 3
fi

echo "[forska] starting vllm on :8000 (backend=$([[ $NNODES -gt 1 ]] && echo ray || echo mp), tp=$TP_SIZE, dp=$DP_SIZE)"
if [[ ! -d "$STACK_ROOT/models/Qwen3-32B-FP8" ]]; then
  echo "[forska] warning: model directory missing: $STACK_ROOT/models/Qwen3-32B-FP8" >&2
  echo "[forska]          vLLM will fail unless the model is present or HF download is configured" >&2
fi

VLLM_BACKEND=$([[ $NNODES -gt 1 ]] && echo ray || echo mp)
VLLM_ENV=(
  --env VLLM_CACHE_ROOT="$VLLM_CACHE_ROOT"
  --env HF_HOME="$HF_HOME"
)
if [[ $NNODES -gt 1 ]]; then
  VLLM_ENV+=(--env RAY_ADDRESS="${HEAD_NODE}:${RAY_PORT}")
  VLLM_ENV+=(--env RAY_TMPDIR="$RAY_TMP_DIR")
fi

apptainer run --cleanenv --nv \
  "${VLLM_ENV[@]}" \
  --bind "$STACK_ROOT/models:/models:ro" \
  "$SIF_VLLM" \
  --model /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --tensor-parallel-size "$TP_SIZE" \
    --data-parallel-size "$DP_SIZE" \
    --gpu-memory-utilization "$VLLM_GPU_UTIL" \
    --enable-auto-tool-choice \
    --tool-call-parser hermes \
    --reasoning-parser deepseek_r1 \
    --distributed-executor-backend "$VLLM_BACKEND" \
    --api-key "$VLLM_API_KEY" \
  >"$LOG_DIR/vllm.log" 2>&1 &

# Wait for vLLM to become ready before starting API
echo "[forska] waiting for vllm to be healthy..."
for i in $(seq 1 60); do
  if curl -sf -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models >/dev/null; then
    echo "[forska] vllm is up"
    break
  fi
  if ! kill -0 $(jobs -pr | head -n1) 2>/dev/null; then
    echo "[forska] vllm process appears to have exited; see $LOG_DIR/vllm.log" >&2
    break
  fi
  sleep 2
done
if ! curl -sf -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models >/dev/null; then
  echo "[forska] warning: vllm is not responding on :8000; API may fail to connect" >&2
fi


API_BINDS=(
  --bind "$DB_URL_FILE:/run/secrets/database_url:ro"
)
[[ -f "$BA_SECRET_FILE" ]] && API_BINDS+=(--bind "$BA_SECRET_FILE:/run/secrets/better_auth_secret:ro")
[[ -f "$BA_URL_FILE" ]] && API_BINDS+=(--bind "$BA_URL_FILE:/run/secrets/better_auth_url:ro")

echo "[forska] starting API on :$API_SERVER_PORT"
apptainer run --cleanenv \
  "${API_BINDS[@]}" \
  --env DATABASE_URL_FILE=/run/secrets/database_url \
  --env BETTER_AUTH_SECRET_FILE=/run/secrets/better_auth_secret \
  --env BETTER_AUTH_URL_FILE=/run/secrets/better_auth_url \
  --env VITE_LLM_SERVER_URL="$VITE_LLM_SERVER_URL" \
  --env VITE_SERVER_API="http://localhost:${API_SERVER_PORT}" \
  --env API_SERVER_PORT="$API_SERVER_PORT" \
  --env VITE_PORT="$VITE_PORT" \
  "$SIF_API" \
  >"$LOG_DIR/api.log" 2>&1 &

echo "[forska] starting app on :$PROD_SERVER (proxies to API :$API_SERVER_PORT)"
apptainer run --cleanenv \
  --env SERVER_HOST=localhost \
  --env API_SERVER_PORT="$API_SERVER_PORT" \
  --env PROD_SERVER="$PROD_SERVER" \
  "$SIF_APP" \
  >"$LOG_DIR/app.log" 2>&1 &

echo "[forska] services launched"
echo "  host:        $(hostname)"
echo "  postgres:    127.0.0.1:$POSTGRES_PORT"
echo "  vllm:        http://127.0.0.1:8000/v1"
if [[ $NNODES -gt 1 ]]; then
  echo "  ray head:    ${HEAD_NODE}:${RAY_PORT} (dashboard :${RAY_DASHBOARD_PORT})"
  echo "  nodes:       ${HOSTS[*]}"
fi
echo "  dist:        ${NNODES} node(s) × ${GPUS_PER_NODE} GPU(s) = ${TOTAL_GPUS} (tp=${TP_SIZE}, dp=${DP_SIZE})"
echo "  api:         http://127.0.0.1:$API_SERVER_PORT"
echo "  app:         http://127.0.0.1:$PROD_SERVER"
echo "[forska] tail logs in: $LOG_DIR"
echo "[forska] for ssh tunnel to the api"
echo "  ssh -N -L 3001:localhost:$API_SERVER_PORT alvis2"
echo "[forska] for ssh tunnel to the vllm server"
echo "  ssh -N -L 8000:localhost:8000 alvis2"

# Block until all background services exit
wait
