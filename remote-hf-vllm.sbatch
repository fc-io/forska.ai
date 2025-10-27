#!/bin/bash
#SBATCH -J remote-hf-vllm
#SBATCH -A NAISS2025-22-715 -p alvis
#SBATCH --nodes=2
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-node=A100:2
#SBATCH --time=01:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@300

set -euo pipefail

echo "[test-vllm] starting on host $(hostname) at $(date)"

# Shared root
export STACK_ROOT=${STACK_ROOT:-$PWD}
mkdir -p "$STACK_ROOT"/{models,hf_cache,logs,.cache}
export HF_HOME=${HF_HOME:-$STACK_ROOT/hf_cache}

# vLLM config
export VLLM_API_KEY=${VLLM_API_KEY:-fake_key}
export VLLM_GPU_UTIL=${VLLM_GPU_UTIL:-0.90}

# Network config
export GPUS_PER_NODE=${GPUS_PER_NODE:-${SLURM_GPUS_ON_NODE:-2}}
export NCCL_DEBUG=${NCCL_DEBUG:-WARN}
export NCCL_ASYNC_ERROR_HANDLING=${NCCL_ASYNC_ERROR_HANDLING:-1}

# SIF location
SIF_VLLM="$STACK_ROOT/vllm-openai_latest.sif"

# Preflight checks
need() { [ -f "$1" ] || { echo "[test-vllm] missing: $1" >&2; exit 2; }; }
need "$SIF_VLLM"

LOG_DIR="$STACK_ROOT/logs/${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

# Multi-node topology
NNODES=${SLURM_NNODES:-1}
HOSTS=( $(scontrol show hostnames "${SLURM_NODELIST:-$(hostname -s)}") )
HEAD_NODE=${HOSTS[0]:-$(hostname -s)}
THIS_NODE=$(hostname -s)
WORKER_NODES=( "${HOSTS[@]:1}" )

# Ray config
RAY_PORT=${RAY_PORT:-6379}
RAY_DASHBOARD_PORT=${RAY_DASHBOARD_PORT:-8265}

# Resolve head IP
if [[ -z "${HEAD_IP:-}" ]]; then
  if command -v getent >/dev/null 2>&1; then
    HEAD_IP=$(getent ahostsv4 "$HEAD_NODE" | awk '{print $1; exit}')
  fi
  if [[ -z "${HEAD_IP:-}" ]]; then
    HEAD_IP=$(hostname -I | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$' || true)
  fi
fi
if [[ -z "${HEAD_IP:-}" ]]; then
  echo "[test-vllm] error: unable to resolve head IP" >&2
  exit 2
fi
echo "[test-vllm] head IP: $HEAD_IP (node: $HEAD_NODE)"

# Ray temp dir
RAY_TMP_DIR=${RAY_TMP_DIR:-/tmp/ray-${SLURM_JOB_ID:-$$}}
mkdir -p "$RAY_TMP_DIR"

# Compute TP/DP sizes
TOTAL_GPUS=$(( NNODES * GPUS_PER_NODE ))
TP_SIZE=${TP_SIZE:-$TOTAL_GPUS}
DP_SIZE=${DP_SIZE:-1}
echo "[test-vllm] total GPUs: $TOTAL_GPUS (nodes=$NNODES, gpus/node=$GPUS_PER_NODE)"
echo "[test-vllm] tensor-parallel-size: $TP_SIZE, data-parallel-size: $DP_SIZE"

# Graceful shutdown
graceful_shutdown() {
  local reason="${1:-cleanup}"
  echo "[test-vllm] shutting down ($reason)..."
  if [[ ${NNODES:-1} -gt 1 ]]; then
    echo "[test-vllm] stopping ray on head"
    apptainer exec --cleanenv --nv "$SIF_VLLM" ray stop >/dev/null 2>&1 || true
    if [[ ${#WORKER_NODES[@]} -gt 0 ]]; then
      echo "[test-vllm] stopping ray on workers"
      srun --nodes=$((NNODES-1)) --ntasks=$((NNODES-1)) \
        --nodelist="$(printf "%s," "${WORKER_NODES[@]}" | sed 's/,$//')" \
        bash -lc "apptainer exec --cleanenv --nv '$SIF_VLLM' ray stop >/dev/null 2>&1 || true" \
        >/dev/null 2>&1 || true
    fi
  fi
  jobs -pr | xargs -r kill -TERM || true
  sleep 2
  jobs -pr | xargs -r kill -KILL || true
}
trap 'graceful_shutdown EXIT' EXIT
trap 'graceful_shutdown SIGNAL' INT TERM
trap 'graceful_shutdown TIME_LIMIT' USR1

echo "[test-vllm] logs -> $LOG_DIR"

############################################
# Start Ray cluster (multi-node)
############################################

if [[ $NNODES -gt 1 ]]; then
  echo "[test-vllm] starting ray cluster (nodes=$NNODES, head=$HEAD_NODE)"

  # Start Ray head
  echo "[test-vllm] starting ray head on $HEAD_NODE"
  apptainer exec --cleanenv --nv \
    --env NCCL_DEBUG="$NCCL_DEBUG" \
    --env NCCL_ASYNC_ERROR_HANDLING="$NCCL_ASYNC_ERROR_HANDLING" \
    --env CUDA_DEVICE_ORDER=PCI_BUS_ID \
    --env RAY_TMPDIR="$RAY_TMP_DIR" \
    --bind "$RAY_TMP_DIR:$RAY_TMP_DIR" \
    "$SIF_VLLM" \
    ray start --head --block \
      --node-ip-address "$HEAD_IP" \
      --port "$RAY_PORT" \
      --dashboard-host 0.0.0.0 \
      --dashboard-port "$RAY_DASHBOARD_PORT" \
      --temp-dir "$RAY_TMP_DIR" \
      --disable-usage-stats \
    >"$LOG_DIR/ray-head.log" 2>&1 &
  RAY_HEAD_PID=$!

  echo "[test-vllm] ray head started (pid=$RAY_HEAD_PID)"
  sleep 5

  if ! kill -0 "$RAY_HEAD_PID" 2>/dev/null; then
    echo "[test-vllm] error: ray head exited early" >&2
    tail -20 "$LOG_DIR/ray-head.log" >&2
    exit 2
  fi

  # Wait for head to be ready
  echo "[test-vllm] waiting for ray head to be ready..."
  for i in $(seq 1 20); do
    if (command -v nc >/dev/null 2>&1 && timeout 2 nc -z "$HEAD_IP" "$RAY_PORT") || \
       timeout 2 bash -lc "echo > /dev/tcp/$HEAD_IP/$RAY_PORT" >/dev/null 2>&1; then
      echo "[test-vllm] ray head is ready"
      break
    fi
    sleep 1
  done

  # Start Ray workers
  WORKER_SCRIPT="$STACK_ROOT/.cache/ray-worker.sh"
  mkdir -p "$(dirname "$WORKER_SCRIPT")"
  cat >"$WORKER_SCRIPT" <<'RAY_WORKER'
#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$RAY_TMP_DIR"

WORKER_IP=$(getent ahostsv4 "$(hostname -s)" | awk '{print $1; exit}' || true)
if [[ -z "${WORKER_IP:-}" ]]; then
  WORKER_IP=$(hostname -I | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$' || true)
fi
if [[ -z "${WORKER_IP:-}" ]]; then
  echo "[test-vllm] worker: failed to resolve IPv4" >&2
  exit 2
fi

ok=0
for i in $(seq 1 20); do
  if (command -v nc >/dev/null 2>&1 && timeout 3 nc -z "${HEAD_IP}" "$RAY_PORT") || \
     (echo >/dev/tcp/"${HEAD_IP}"/"$RAY_PORT") >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 1
done
if [[ $ok -ne 1 ]]; then
  echo "[test-vllm] worker: head not reachable" >&2
  exit 2
fi

exec apptainer exec --cleanenv --nv \
  --env NCCL_DEBUG="${NCCL_DEBUG}" \
  --env NCCL_ASYNC_ERROR_HANDLING="${NCCL_ASYNC_ERROR_HANDLING}" \
  --env CUDA_DEVICE_ORDER=PCI_BUS_ID \
  --env RAY_TMPDIR="${RAY_TMP_DIR}" \
  --env HF_HOME="${HF_HOME}" \
  --bind "${RAY_TMP_DIR}:${RAY_TMP_DIR}" \
  --bind "${HF_HOME}:${HF_HOME}" \
  "${SIF_VLLM}" \
  ray start --block \
    --node-ip-address "${WORKER_IP}" \
    --address "${HEAD_IP}:${RAY_PORT}" \
    --disable-usage-stats
RAY_WORKER
  chmod +x "$WORKER_SCRIPT"

  if [[ ${#WORKER_NODES[@]} -gt 0 ]]; then
    echo "[test-vllm] starting ray workers..."
    srun --nodes=$((NNODES-1)) --ntasks=$((NNODES-1)) \
      --export=ALL,HEAD_IP=${HEAD_IP},RAY_PORT=${RAY_PORT},RAY_TMP_DIR=${RAY_TMP_DIR},SIF_VLLM=${SIF_VLLM},NCCL_DEBUG=${NCCL_DEBUG},NCCL_ASYNC_ERROR_HANDLING=${NCCL_ASYNC_ERROR_HANDLING},HF_HOME=${HF_HOME},STACK_ROOT=${STACK_ROOT} \
      --nodelist="$(printf "%s," "${WORKER_NODES[@]}" | sed 's/,$//')" \
      --output "$LOG_DIR/ray-worker-%N.log" \
      bash -lc "$WORKER_SCRIPT" &
    RAY_WORKERS_PID=$!
    echo "[test-vllm] ray workers started (pid=$RAY_WORKERS_PID)"
  fi

  sleep 3

  # Verify Ray cluster
  echo "[test-vllm] verifying ray cluster..."
  for i in $(seq 1 30); do
    if apptainer exec --cleanenv --nv \
         --env RAY_ADDRESS="${HEAD_IP}:${RAY_PORT}" \
         "$SIF_VLLM" ray status >/dev/null 2>&1; then
      echo "[test-vllm] ray cluster healthy"
      apptainer exec --cleanenv --nv --env RAY_ADDRESS="${HEAD_IP}:${RAY_PORT}" "$SIF_VLLM" ray status
      break
    fi
    echo "[test-vllm] waiting for ray cluster (attempt $i/30)..."
    sleep 2
  done
fi

############################################
# Start vLLM
############################################

echo "[test-vllm] starting vllm..."

VLLM_BACKEND=$([[ $NNODES -gt 1 ]] && echo ray || echo mp)
VLLM_ENV=(
  --env VLLM_CACHE_ROOT="$STACK_ROOT/.cache/vllm"
  --env HF_HOME="$HF_HOME"
)
if [[ $NNODES -gt 1 ]]; then
  VLLM_ENV+=(--env RAY_ADDRESS="${HEAD_IP}:${RAY_PORT}")
  VLLM_ENV+=(--env RAY_TMPDIR="$RAY_TMP_DIR")
fi

apptainer run --cleanenv --nv \
  "${VLLM_ENV[@]}" \
  --env CUDA_DEVICE_ORDER=PCI_BUS_ID \
  --bind "$HF_HOME:$HF_HOME" \
  --bind "$STACK_ROOT/.cache:$STACK_ROOT/.cache" \
  "$SIF_VLLM" \
  "Qwen/Qwen3-30B-A3B-Instruct-2507" \
    --host 0.0.0.0 --port 8000 \
    --tensor-parallel-size "$TP_SIZE" \
    --data-parallel-size "$DP_SIZE" \
    --gpu-memory-utilization "$VLLM_GPU_UTIL" \
    --max-model-len 32768 \
    --enable-auto-tool-choice \
    --tool-call-parser hermes \
    --reasoning-parser deepseek_r1 \
    --distributed-executor-backend "$VLLM_BACKEND" \
    --api-key "$VLLM_API_KEY" \
  >"$LOG_DIR/vllm.log" 2>&1 &

VLLM_PID=$!
echo "[test-vllm] vllm started (pid=$VLLM_PID)"

# Wait for vLLM to be ready (up to 30 minutes)
echo "[test-vllm] waiting for vllm to be ready..."
for i in $(seq 1 900); do
  if curl -sf -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models >/dev/null; then
    echo "[test-vllm] vllm is ready"
    curl -sf -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models | jq .
    break
  fi
  if ! kill -0 "$VLLM_PID" 2>/dev/null; then
    echo "[test-vllm] error: vllm exited early" >&2
    tail -20 "$LOG_DIR/vllm.log" >&2
    exit 2
  fi
  if [[ $((i % 10)) -eq 0 ]]; then
    echo "[test-vllm] still waiting for vllm... (attempt $i/900)"
    tail -5 "$LOG_DIR/vllm.log" >&2
  fi
  sleep 2
done

if ! curl -sf -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models >/dev/null; then
  echo "[test-vllm] error: vllm not responding after 30 minutes" >&2
  tail -20 "$LOG_DIR/vllm.log" >&2
  exit 2
fi

############################################
# Summary
############################################

echo "[test-vllm] services running"
echo "  host:        $(hostname)"
echo "  vllm:        http://127.0.0.1:8000/v1"
if [[ $NNODES -gt 1 ]]; then
  echo "  ray head:    ${HEAD_NODE} (${HEAD_IP}:${RAY_PORT})"
  echo "  ray dashboard: http://${HEAD_IP}:${RAY_DASHBOARD_PORT}"
  echo "  nodes:       ${HOSTS[*]}"
fi
echo "  dist:        ${NNODES} node(s) × ${GPUS_PER_NODE} GPU(s) = ${TOTAL_GPUS} (tp=${TP_SIZE}, dp=${DP_SIZE})"
echo "  logs:        $LOG_DIR"

# Block until all background services exit
wait

