#!/bin/bash
#SBATCH -J forska-mn5-sglang
#SBATCH -A ehpc482
#SBATCH --partition=acc
#SBATCH --qos=acc_debug
#SBATCH --nodes=2
#SBATCH --ntasks-per-node=4
#SBATCH --cpus-per-task=20
#SBATCH --gres=gpu:4
#SBATCH --time=01:59:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

# MareNostrum 5 SGLang inference server for GPT-OSS-120B
# Hardware: 4x H100 64GB per node, NVLink intra-node, InfiniBand inter-node
# Default config uses 1 node (4 H100s total) with tp=4
#
# Standard (1 node, tp=4):
#   sbatch --export=ALL forska-mn5-sglang.sbatch
#
# Multi-node (2 nodes, 4 H100s each -> 8 GPUs):
#   Recommended: TP=4 (intra-node), PP=2 (inter-node) for optimized throughput/stability.
#   sbatch -N 2 --export=ALL forska-mn5-sglang.sbatch
#
#   Alternative (extreme throughput): TP=8 (cross-node), PP=1
#   sbatch -N 2 --export=ALL,TP_SIZE=8,PP_SIZE=1 forska-mn5-sglang.sbatch
#
# Note: Ensure you are using a compatible image (e.g., lmsysorg/sglang:v0.5.0rc2-cu126)
# for best GPT-OSS support on Hopper.

set -euo pipefail

echo "[mn5] starting on $(hostname) at $(date)"

# Paths
export STACK_ROOT=${STACK_ROOT:-/gpfs/projects/ehpc482/dev}
mkdir -p "$STACK_ROOT"/{hf_cache,logs,.cache,.cache/sglang,tmp}

export HF_HOME=$STACK_ROOT/hf_cache
export XDG_CACHE_HOME=$STACK_ROOT/.cache
export SGLANG_CACHE_DIR=$STACK_ROOT/.cache/sglang
export TMPDIR=$STACK_ROOT/tmp

# Load singularity module and resolve absolute path (needed for srun on worker nodes)
module load singularity/4.1.5
SINGULARITY_BIN=$(which singularity)
if [[ -z "$SINGULARITY_BIN" ]]; then
  echo "[mn5] ERROR: singularity not found after module load" >&2
  exit 1
fi
echo "[mn5] using container runtime: $SINGULARITY_BIN"

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

# SGLang config - default model
export SGLANG_MODEL=${SGLANG_MODEL:-openai/gpt-oss-120b}
export SGLANG_PORT=${SGLANG_PORT:-30000}

# Resolve model path: if it looks like a HuggingFace ID (contains /), try to find it in the cache
# Otherwise assume it's already a local path
if [[ "$SGLANG_MODEL" == */* && ! -d "$SGLANG_MODEL" ]]; then
  # Convert HF ID to cache directory format: org/model -> models--org--model
  # Note: tr cannot replace single char with multiple chars, use sed instead
  HF_CACHE_NAME="models--$(echo "$SGLANG_MODEL" | sed 's|/|--|g')"

  # Check multiple possible locations:
  # 1. Direct download: $HF_HOME/models--org--model/
  # 2. Standard HF cache: $HF_HOME/hub/models--org--model/snapshots/<hash>/

  if [[ -d "$HF_HOME/$HF_CACHE_NAME" && -f "$HF_HOME/$HF_CACHE_NAME/config.json" ]]; then
    # Direct download structure (what user has)
    SGLANG_MODEL_PATH="$HF_HOME/$HF_CACHE_NAME"
    echo "[mn5] resolved model to: $SGLANG_MODEL_PATH"
  elif [[ -d "$HF_HOME/hub/$HF_CACHE_NAME/snapshots" ]]; then
    # Standard HF cache structure
    SNAPSHOT_DIR=$(ls -t "$HF_HOME/hub/$HF_CACHE_NAME/snapshots" 2>/dev/null | head -1)
    if [[ -n "$SNAPSHOT_DIR" && -d "$HF_HOME/hub/$HF_CACHE_NAME/snapshots/$SNAPSHOT_DIR" ]]; then
      SGLANG_MODEL_PATH="$HF_HOME/hub/$HF_CACHE_NAME/snapshots/$SNAPSHOT_DIR"
      echo "[mn5] resolved model to: $SGLANG_MODEL_PATH"
    else
      echo "[mn5] ERROR: Model cache exists but no snapshots found" >&2
      exit 1
    fi
  else
    echo "[mn5] ERROR: Model not found: $SGLANG_MODEL" >&2
    echo "[mn5] Searched in:" >&2
    echo "  - $HF_HOME/$HF_CACHE_NAME/" >&2
    echo "  - $HF_HOME/hub/$HF_CACHE_NAME/snapshots/" >&2
    echo "" >&2
    echo "[mn5] Available models:" >&2
    ls -d "$HF_HOME"/models--* 2>/dev/null | xargs -n1 basename || echo "  (none in $HF_HOME)" >&2
    ls -d "$HF_HOME"/hub/models--* 2>/dev/null | xargs -n1 basename || true
    exit 1
  fi
else
  # Already a local path or doesn't contain /
  SGLANG_MODEL_PATH="$SGLANG_MODEL"
fi

if [[ -f "$SGLANG_MODEL_PATH/config.json" && -f "$SGLANG_MODEL_PATH/modeling_mimo_v2_flash.py" ]]; then
  if grep -q "class MiMoV2FlashForCausalLM" "$SGLANG_MODEL_PATH/modeling_mimo_v2_flash.py"; then
    if ! grep -q "MiMoForCausalLM" "$SGLANG_MODEL_PATH/modeling_mimo_v2_flash.py"; then
      printf '\nMiMoForCausalLM = MiMoV2FlashForCausalLM\n' >> "$SGLANG_MODEL_PATH/modeling_mimo_v2_flash.py"
      echo "[mn5] patched modeling_mimo_v2_flash.py with MiMoForCausalLM alias"
    fi
    if grep -q "MiMoV2FlashModel" "$SGLANG_MODEL_PATH/config.json" || grep -q "MiMoV2FlashForCausalLM" "$SGLANG_MODEL_PATH/config.json"; then
      sed -i 's/MiMoV2FlashModel/MiMoForCausalLM/g; s/MiMoV2FlashForCausalLM/MiMoForCausalLM/g' "$SGLANG_MODEL_PATH/config.json"
      echo "[mn5] patched config.json architectures to MiMoForCausalLM"
    fi
  fi
fi

# Default tp/pp/dp:
# Option A (Standard 2-node): TP=4 (intra-node), PP=2 (inter-node), DP=1.
# This keeps tensor parallelism within the NVLink domain.
TP_SIZE_SET=0
PP_SIZE_SET=0
DP_SIZE_SET=0
[[ -n "${TP_SIZE+x}" ]] && TP_SIZE_SET=1
[[ -n "${PP_SIZE+x}" ]] && PP_SIZE_SET=1
[[ -n "${DP_SIZE+x}" ]] && DP_SIZE_SET=1

if (( NNODES > 1 )); then
  # Multi-node defaults: TP=GPUS_PER_NODE, PP=NNODES (assuming 1 model spans all nodes)
  export TP_SIZE=${TP_SIZE:-$GPUS_PER_NODE}
  export PP_SIZE=${PP_SIZE:-$NNODES}
  export DP_SIZE=${DP_SIZE:-1}
else
  # Single node: TP across all GPUs
  export TP_SIZE=${TP_SIZE:-$TOTAL_GPUS}
  export PP_SIZE=${PP_SIZE:-1}
  export DP_SIZE=${DP_SIZE:-1}
fi

FP8_TP_RECOMMENDED=$(
  SGLANG_MODEL_PATH="$SGLANG_MODEL_PATH" TOTAL_GPUS="$TOTAL_GPUS" python - <<'PY'
import json
import os

config_path = os.path.join(os.environ.get("SGLANG_MODEL_PATH", ""), "config.json")
total_gpus = int(os.environ.get("TOTAL_GPUS", "0") or 0)
if not config_path or not os.path.isfile(config_path) or not total_gpus:
    print("")
    raise SystemExit
data = json.load(open(config_path))
quant = data.get("quantization_config") or {}
if quant.get("quant_method") != "fp8":
    print("")
    raise SystemExit
block = quant.get("weight_block_size") or []
block_n = block[1] if len(block) > 1 else None
qkv_candidates = []
prefixes = []
for key in data.keys():
    if key.endswith("num_attention_heads"):
        prefixes.append(key[: -len("num_attention_heads")])
for prefix in prefixes:
    num_heads = data.get(f"{prefix}num_attention_heads")
    num_kv_heads = data.get(f"{prefix}num_key_value_heads") or data.get(f"{prefix}num_kv_heads") or num_heads
    hidden = data.get(f"{prefix}hidden_size") or data.get(f"{prefix}n_embd") or data.get(f"{prefix}d_model")
    head_dim = data.get(f"{prefix}head_dim") or (int(hidden // num_heads) if hidden and num_heads and hidden % num_heads == 0 else None)
    if num_heads and head_dim:
        qkv_candidates.append((int(num_heads) + 2 * int(num_kv_heads or num_heads)) * int(head_dim))
if not qkv_candidates:
    for key, val in data.items():
        if key in ("hidden_size", "d_model", "n_embd") or key.endswith("hidden_size"):
            if isinstance(val, int):
                qkv_candidates.append(int(val) * 3)
if not block_n or not qkv_candidates:
    print("")
    raise SystemExit
for d in range(total_gpus, 0, -1):
    if total_gpus % d != 0:
        continue
    if all((qkv_out % (block_n * d) == 0) for qkv_out in qkv_candidates):
        print(d)
        raise SystemExit
print("")
PY
)

if [[ -n "$FP8_TP_RECOMMENDED" && "$TP_SIZE_SET" -eq 0 && "$FP8_TP_RECOMMENDED" -ne "$TP_SIZE" ]]; then
  export TP_SIZE="$FP8_TP_RECOMMENDED"
  if [[ "$DP_SIZE_SET" -eq 0 ]]; then
    export DP_SIZE=$((TOTAL_GPUS / TP_SIZE))
  fi
  echo "[mn5] adjusted tp/dp for fp8 block size: tp=$TP_SIZE dp=$DP_SIZE"
fi

# Model-specific settings (tuned for H100 w/ GPT-OSS)
export SGLANG_MAX_RUNNING_REQUESTS=${SGLANG_MAX_RUNNING_REQUESTS:-1024}
# Memory fraction 0.85 recommended for H100 to avoid OOM
export SGLANG_MEM_FRACTION=${SGLANG_MEM_FRACTION:-0.85}
# Lower chunked prefill to 8192 to avoid prefill OOMs
export SGLANG_CHUNKED_PREFILL_SIZE=${SGLANG_CHUNKED_PREFILL_SIZE:-8192}
export SGLANG_CONTEXT_LENGTH=${SGLANG_CONTEXT_LENGTH:-131072}
export SGLANG_DTYPE=${SGLANG_DTYPE:-bfloat16}
export SGLANG_CUDA_GRAPH_MAX_BS=${SGLANG_CUDA_GRAPH_MAX_BS:-32}
# Reasoning parser for models with thinking/channel tokens (gpt-oss, deepseek-r1, qwen3)
# This separates reasoning traces into 'reasoning_content' field in the API response
export SGLANG_REASONING_PARSER=${SGLANG_REASONING_PARSER:-gpt-oss}
export SGLANG_TOOL_CALL_PARSER=${SGLANG_TOOL_CALL_PARSER:-gpt-oss}

# NCCL / Network Tunables for MareNostrum 5 ACC (ConnectX-7 NDR200)
# 'ib0' is the standard IPoIB interface on MN5
export NCCL_DEBUG=${NCCL_DEBUG:-WARN}
export NCCL_SOCKET_IFNAME=${NCCL_SOCKET_IFNAME:-ib0}
export NCCL_IB_DISABLE=${NCCL_IB_DISABLE:-0}
export NCCL_IB_HCA=${NCCL_IB_HCA:-mlx5}

# Network diagnostics
echo "[mn5] Network Interfaces:"
ip addr | grep -E '^[0-9]+: ' | awk '{print $2}' | tr -d ':' | xargs echo "  "
echo "[mn5] InfiniBand Devices:"
command -v ibv_devinfo >/dev/null && ibv_devinfo -l || echo "  (ibv_devinfo not found)"

echo "[mn5] model=$SGLANG_MODEL (path: $SGLANG_MODEL_PATH)"
echo "[mn5] nodes=$NNODES gpus/node=$GPUS_PER_NODE total_gpus=$TOTAL_GPUS tp=$TP_SIZE pp=$PP_SIZE dp=$DP_SIZE"

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

echo "[mn5] launching SGLang with tp=$TP_SIZE pp=$PP_SIZE dp=$DP_SIZE"

# Build SGLang command with model-specific settings
# Note: Some flags like --moe-a2a-backend, --attention-backend, --speculative-*
# may require specific SGLang versions - using conservative defaults
SGLANG_ARGS=(
  --model-path "$SGLANG_MODEL_PATH"
  --served-model-name "$SGLANG_MODEL"
  --host 0.0.0.0
  --port "$SGLANG_PORT"
  --tensor-parallel-size "$TP_SIZE"
  --pipeline-parallel-size "$PP_SIZE"
  --data-parallel-size "$DP_SIZE"
  --trust-remote-code
  --mem-fraction-static "$SGLANG_MEM_FRACTION"
  --max-running-requests "$SGLANG_MAX_RUNNING_REQUESTS"
  --chunked-prefill-size "$SGLANG_CHUNKED_PREFILL_SIZE"
  --context-length "$SGLANG_CONTEXT_LENGTH"
  --dtype "$SGLANG_DTYPE"
  --cuda-graph-max-bs "$SGLANG_CUDA_GRAPH_MAX_BS"
  --enable-metrics
  --download-dir /hf
)

if [[ -n "${SGLANG_REASONING_PARSER:-}" ]]; then
  SGLANG_ARGS+=( --reasoning-parser "$SGLANG_REASONING_PARSER" )
fi

if [[ -n "${SGLANG_TOOL_CALL_PARSER:-}" ]]; then
  SGLANG_ARGS+=( --tool-call-parser "$SGLANG_TOOL_CALL_PARSER" )
fi

if (( NNODES > 1 && DP_SIZE > 1 )); then
  # Disable dp-attention by default as it can cause performance regression due to sync overhead
  [[ "${SGLANG_ENABLE_DP_ATTENTION:-0}" -eq 1 ]] && SGLANG_ARGS+=( --enable-dp-attention )
fi

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

# Build the container command (using absolute path resolved earlier)
# Note: No HF token needed - models are pre-downloaded and no outbound access
# HF_HUB_OFFLINE=1 ensures no download attempts are made
CONTAINER_CMD="$SINGULARITY_BIN exec --cleanenv --nv \
  --env HF_HOME=/hf --env HUGGINGFACE_HUB_CACHE=/hf \
  --env HF_HUB_OFFLINE=1 \
  --bind $HF_HOME:/hf:rw \
  --env SGLANG_CACHE_DIR=/sg --bind $SGLANG_CACHE_DIR:/sg:rw \
  --env NCCL_DEBUG="$NCCL_DEBUG" \
  --env NCCL_SOCKET_IFNAME="$NCCL_SOCKET_IFNAME" \
  --env NCCL_IB_DISABLE="$NCCL_IB_DISABLE" \
  --env NCCL_IB_HCA="$NCCL_IB_HCA" \
  $SIF_SGLANG \
  python -m sglang.launch_server ${SGLANG_ARGS[*]}"

if (( NNODES > 1 )); then
  # Multi-node: use srun to launch on all nodes with correct node-rank
  # Using absolute path to singularity binary - no module load needed on worker nodes
  echo "[mn5] Launching with srun across $NNODES nodes..."
  srun --nodes=$NNODES --ntasks=$NNODES --ntasks-per-node=1 \
    bash -c "export NODE_RANK=\$SLURM_PROCID; $CONTAINER_CMD --node-rank \$NODE_RANK" \
    >"$LOG_DIR/sglang.log" 2>&1 &
  SGLANG_PID=$!
else
  # Single node: run directly
  $CONTAINER_CMD >"$LOG_DIR/sglang.log" 2>&1 &
  SGLANG_PID=$!
fi

# Wait for server - large models can take 15-20 minutes to load
wait_for_http "http://localhost:$SGLANG_PORT/v1/models" 2400 "$SGLANG_PID"

echo ""
echo "=============================================="
echo "[mn5] SGLang ready!"
echo "  Host:     $(hostname)"
echo "  Endpoint: http://$(hostname):$SGLANG_PORT/v1"
echo "  Model:    $SGLANG_MODEL"
echo "  Config:   tp=$TP_SIZE pp=$PP_SIZE dp=$DP_SIZE on $TOTAL_GPUS GPUs ($NNODES nodes)"
echo ""
echo "SSH tunnel from local machine:"
echo "  ssh -N -L $SGLANG_PORT:$(hostname):$SGLANG_PORT alog"
echo ""
echo "Test:"
echo "  curl http://localhost:$SGLANG_PORT/v1/models"
echo ""
echo "Example request (with thinking mode):"
cat << EOF
  curl http://localhost:30000/v1/chat/completions \\
    -H "Content-Type: application/json" \\
    -d '{
      "model": "$SGLANG_MODEL",
      "messages": [{"role": "user", "content": "Hello!"}],
      "max_tokens": 4096,
      "temperature": 0.8,
      "top_p": 0.95,
      "chat_template_kwargs": {"enable_thinking": true}
    }'
EOF
echo "=============================================="

# Keep running
wait
