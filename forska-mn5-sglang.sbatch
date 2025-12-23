#!/bin/bash
#SBATCH -J forska-mn5-sglang
#SBATCH -A ehpc482
#SBATCH --qos=acc_ehpc
#SBATCH --nodes=2
#SBATCH --gres=gpu:4
#SBATCH --time=08:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

# MareNostrum 5 SGLang inference server for MiMo-V2-Flash
# Default config requires 2 nodes (8 H100s total) with tp=8
#
# Standard (2 nodes, tp=8):
#   sbatch --export=ALL forska-mn5-sglang.sbatch
#
# Override for smaller models:
#   sbatch -N 1 --export=ALL,SGLANG_MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507,TP_SIZE=4 forska-mn5-sglang.sbatch

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
TOTAL_GPUS=$((NNODES * GPUS_PER_NODE))
HEAD_NODE=${HOSTS[0]}

# Get head IP
HEAD_IP=$(getent ahostsv4 "$HEAD_NODE" 2>/dev/null | awk '{print $1; exit}')
[[ -z "$HEAD_IP" ]] && HEAD_IP=$(hostname -I | awk '{print $1}')
echo "[mn5] HEAD_NODE=$HEAD_NODE HEAD_IP=$HEAD_IP"

# SGLang config - MiMo-V2-Flash recommended settings
export SGLANG_MODEL=${SGLANG_MODEL:-XiaomiMiMo/MiMo-V2-Flash}
export SGLANG_PORT=${SGLANG_PORT:-30000}

# MiMo-V2-Flash requires tp=8 (2 nodes x 4 GPUs)
# For single node, use tp=4
export TP_SIZE=${TP_SIZE:-$TOTAL_GPUS}
export DP_SIZE=${DP_SIZE:-1}

# MiMo-V2-Flash specific settings from HuggingFace
export SGLANG_MAX_RUNNING_REQUESTS=${SGLANG_MAX_RUNNING_REQUESTS:-128}
export SGLANG_MEM_FRACTION=${SGLANG_MEM_FRACTION:-0.75}
export SGLANG_CHUNKED_PREFILL_SIZE=${SGLANG_CHUNKED_PREFILL_SIZE:-16384}
export SGLANG_CONTEXT_LENGTH=${SGLANG_CONTEXT_LENGTH:-131072}

echo "[mn5] model=$SGLANG_MODEL"
echo "[mn5] nodes=$NNODES gpus/node=$GPUS_PER_NODE total_gpus=$TOTAL_GPUS tp=$TP_SIZE dp=$DP_SIZE"

# GPU detection
if command -v nvidia-smi &>/dev/null; then
  nvidia-smi --query-gpu=name,memory.total --format=csv
fi

# Cleanup handler
graceful_shutdown() {
  echo "[mn5] shutting down..."
  [[ -n "${SGLANG_PID:-}" ]] && kill -TERM "$SGLANG_PID" 2>/dev/null || true
  jobs -pr | xargs -r kill -TERM 2>/dev/null || true
  sleep 2
  jobs -pr | xargs -r kill -KILL 2>/dev/null || true
}
trap graceful_shutdown EXIT INT TERM USR1

# Wait for HTTP endpoint
wait_for_http() {
  local url="$1" timeout="${2:-600}" pid="${3:-}"
  echo "[mn5] waiting for $url (timeout: ${timeout}s, large model load may take 10-20 min)..."
  for ((i=1; i<=timeout/2; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "[mn5] $url ready after $((i*2))s"
      return 0
    fi
    [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null && { echo "[mn5] process $pid died"; return 1; }
    if (( i % 60 == 0 )); then
      echo "[mn5] still waiting... ($((i*2))s elapsed)"
    fi
    sleep 2
  done
  echo "[mn5] timeout waiting for $url"
  return 1
}

# Set environment for multi-node
export CUDA_DEVICE_ORDER=PCI_BUS_ID

echo "[mn5] launching SGLang with tp=$TP_SIZE dp=$DP_SIZE"

# Build SGLang command with MiMo-V2-Flash recommended settings
# Note: Some flags like --moe-a2a-backend, --attention-backend, --speculative-*
# may require specific SGLang versions - using conservative defaults
SGLANG_ARGS=(
  --model-path "$SGLANG_MODEL"
  --served-model-name mimo-v2-flash
  --host 0.0.0.0
  --port "$SGLANG_PORT"
  --tensor-parallel-size "$TP_SIZE"
  --data-parallel-size "$DP_SIZE"
  --trust-remote-code
  --mem-fraction-static "$SGLANG_MEM_FRACTION"
  --max-running-requests "$SGLANG_MAX_RUNNING_REQUESTS"
  --chunked-prefill-size "$SGLANG_CHUNKED_PREFILL_SIZE"
  --context-length "$SGLANG_CONTEXT_LENGTH"
  --enable-metrics
  --download-dir /hf
  --reasoning-parser qwen3
)

# Multi-node distributed setup
if (( NNODES > 1 )); then
  # Find master port
  MASTER_PORT=${MASTER_PORT:-29500}

  echo "[mn5] multi-node distributed mode: $NNODES nodes, master=$HEAD_IP:$MASTER_PORT"

  # Add distributed args (node-rank is set dynamically via SLURM_PROCID in srun)
  SGLANG_ARGS+=(
    --nnodes "$NNODES"
    --dist-init-addr "$HEAD_IP:$MASTER_PORT"
  )
fi

# Launch SGLang
echo "[mn5] SGLang args: ${SGLANG_ARGS[*]}"

# Build the apptainer command
APPTAINER_CMD="apptainer exec --cleanenv --nv \
  --env HF_HOME=/hf --env HUGGINGFACE_HUB_CACHE=/hf \
  --env HF_TOKEN=${HF_TOKEN:-} --env HUGGINGFACE_HUB_TOKEN=${HUGGINGFACE_HUB_TOKEN:-} \
  --bind $HF_HOME:/hf:rw \
  --env SGLANG_CACHE_DIR=/sg --bind $SGLANG_CACHE_DIR:/sg:rw \
  --env NCCL_DEBUG=${NCCL_DEBUG:-WARN} \
  $SIF_SGLANG \
  python -m sglang.launch_server ${SGLANG_ARGS[*]}"

if (( NNODES > 1 )); then
  # Multi-node: use srun to launch on all nodes with correct node-rank
  # Each node gets its rank from SLURM_PROCID
  echo "[mn5] Launching with srun across $NNODES nodes..."
  srun --nodes=$NNODES --ntasks=$NNODES --ntasks-per-node=1 \
    bash -c "export NODE_RANK=\$SLURM_PROCID; $APPTAINER_CMD --node-rank \$NODE_RANK" \
    >"$LOG_DIR/sglang.log" 2>&1 &
  SGLANG_PID=$!
else
  # Single node: run directly
  $APPTAINER_CMD >"$LOG_DIR/sglang.log" 2>&1 &
  SGLANG_PID=$!
fi

# Wait for server - large models can take 15-20 minutes to load
wait_for_http "http://localhost:$SGLANG_PORT/v1/models" 2400 "$SGLANG_PID"

echo ""
echo "=============================================="
echo "[mn5] SGLang ready!"
echo "  Host:     $(hostname)"
echo "  Endpoint: http://$(hostname):$SGLANG_PORT/v1"
echo "  Model:    $SGLANG_MODEL (served as mimo-v2-flash)"
echo "  Config:   tp=$TP_SIZE dp=$DP_SIZE on $TOTAL_GPUS GPUs ($NNODES nodes)"
echo ""
echo "SSH tunnel from local machine:"
echo "  ssh -N -L $SGLANG_PORT:$(hostname):$SGLANG_PORT alog"
echo ""
echo "Test:"
echo "  curl http://localhost:$SGLANG_PORT/v1/models"
echo ""
echo "Example request (with thinking mode):"
cat << 'EOF'
  curl http://localhost:30000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
      "model": "mimo-v2-flash",
      "messages": [{"role": "user", "content": "Hello MiMo!"}],
      "max_tokens": 4096,
      "temperature": 0.8,
      "top_p": 0.95,
      "chat_template_kwargs": {"enable_thinking": true}
    }'
EOF
echo "=============================================="

# Keep running
wait
