#!/bin/bash
#SBATCH -J forska-alvis
#SBATCH -A NAISS2025-22-715 -p alvis
#SBATCH --nodes=1
#SBATCH --gpus-per-node=A100fat:2
#SBATCH --time=08:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

set -euo pipefail

echo "[forska] starting on host $(hostname) at $(date)"

export STACK_ROOT=${STACK_ROOT:-/mimer/NOBACKUP/groups/clin-agent-bench/dev}
mkdir -p "$STACK_ROOT"/{pgdata,hf_cache,logs,.cache,.secrets}

export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$STACK_ROOT/.cache}
export HF_HOME=${HF_HOME:-$STACK_ROOT/hf_cache}
export SGLANG_CACHE_DIR=${SGLANG_CACHE_DIR:-$XDG_CACHE_HOME/sglang}
export VLLM_CACHE_ROOT=${VLLM_CACHE_ROOT:-$XDG_CACHE_HOME/vllm}
export TORCHINDUCTOR_CACHE_DIR=${TORCHINDUCTOR_CACHE_DIR:-$VLLM_CACHE_ROOT/torchinductor}
export TRITON_CACHE_DIR=${TRITON_CACHE_DIR:-$VLLM_CACHE_ROOT/triton}
mkdir -p "$VLLM_CACHE_ROOT" "$TORCHINDUCTOR_CACHE_DIR" "$TRITON_CACHE_DIR"

export APPTAINER_TMPDIR=${APPTAINER_TMPDIR:-/tmp}
export TMPDIR=${TMPDIR:-$APPTAINER_TMPDIR}
export APPTAINER_CACHEDIR=${APPTAINER_CACHEDIR:-$STACK_ROOT/.apptainer/cache}
export SINGULARITY_TMPDIR=${SINGULARITY_TMPDIR:-$APPTAINER_TMPDIR}
export SINGULARITY_CACHEDIR=${SINGULARITY_CACHEDIR:-$APPTAINER_CACHEDIR}
mkdir -p "$APPTAINER_TMPDIR" "$APPTAINER_CACHEDIR"

export GHCR_OWNER=${GHCR_OWNER:-fc-io}
export GHCR_USER=${GHCR_USER:-fc-io}
export POSTGRES_PORT=${POSTGRES_PORT:-5432}
export API_SERVER_PORT=${API_SERVER_PORT:-3001}
export PROD_SERVER=${PROD_SERVER:-8181}
export SGLANG_PORT=${SGLANG_PORT:-30000}
export SGLANG_LOCAL_PORT_BASE=${SGLANG_LOCAL_PORT_BASE:-30001}
export GPUS_PER_NODE=${GPUS_PER_NODE:-${SLURM_GPUS_ON_NODE:-1}}
export NCCL_DEBUG=${NCCL_DEBUG:-WARN}
export NCCL_ASYNC_ERROR_HANDLING=${NCCL_ASYNC_ERROR_HANDLING:-1}
export VITE_LLM_SERVER_URL=${VITE_LLM_SERVER_URL:-http://localhost:${SGLANG_PORT}/v1}
export VITE_SERVER_API=${VITE_SERVER_API:-http://localhost:${API_SERVER_PORT}}
export VITE_PORT=${VITE_PORT:-8181}

SIF_DB="$STACK_ROOT/postgres_18.sif"
SIF_SGLANG="$STACK_ROOT/sglang_latest.sif"
SIF_API="$STACK_ROOT/api_server.sif"
SIF_APP="$STACK_ROOT/app_server.sif"
export SIF_DB SIF_SGLANG SIF_API SIF_APP

DB_PW_FILE="$STACK_ROOT/.secrets/db_password.txt"
DB_URL_FILE="$STACK_ROOT/.secrets/database_url.txt"
BA_SECRET_FILE="$STACK_ROOT/.secrets/better_auth_secret.txt"
BA_URL_FILE="$STACK_ROOT/.secrets/better_auth_url.txt"
HF_TOKEN_FILE=${HF_TOKEN_FILE:-$STACK_ROOT/.secrets/hf_token.txt}

if [[ -z "${HF_TOKEN:-}" && -f "$HF_TOKEN_FILE" ]]; then
  HF_TOKEN=$(<"$HF_TOKEN_FILE")
  export HF_TOKEN
  echo "[forska] loaded HF token from $HF_TOKEN_FILE"
fi

export HUGGINGFACE_HUB_TOKEN=${HUGGINGFACE_HUB_TOKEN:-${HF_TOKEN:-}}
export HUGGINGFACE_HUB_CACHE=${HUGGINGFACE_HUB_CACHE:-$HF_HOME}

need() {
  [[ -f "$1" ]] || { echo "[forska] missing: $1" >&2; exit 2; }
}

need "$SIF_DB"
need "$SIF_SGLANG"
need "$SIF_API"
need "$SIF_APP"
need "$DB_PW_FILE"
need "$DB_URL_FILE"

LOG_DIR="$STACK_ROOT/logs/${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

NODELIST_SRC=${SLURM_JOB_NODELIST:-${SLURM_NODELIST:-${SLURM_STEP_NODELIST:-$(hostname -s)}}}
readarray -t HOSTS < <(scontrol show hostnames "$NODELIST_SRC")
NNODES=${NNODES:-${SLURM_JOB_NUM_NODES:-${SLURM_NNODES:-${#HOSTS[@]}}}}
HEAD_NODE=${HOSTS[0]:-$(hostname -s)}

postgres_ping() {
  if apptainer exec --cleanenv "$SIF_DB" pg_isready \
    -h 127.0.0.1 \
    -p "$POSTGRES_PORT" \
    -d "${DB_NAME:-postgres}" \
    -U "${DB_USER:-postgres}" >/dev/null 2>&1; then
    return 0
  fi

  if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$POSTGRES_PORT" >/dev/null 2>&1; then
    return 0
  fi

  if (exec 3<>"/dev/tcp/127.0.0.1/$POSTGRES_PORT") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    return 0
  fi

  return 1
}

wait_for_postgres() {
  local pid="$1"
  local log_file="$2"
  local attempts=${POSTGRES_READY_ATTEMPTS:-60}
  local delay=${POSTGRES_READY_DELAY:-2}

  for ((i=1; i<=attempts; i++)); do
    if postgres_ping; then
      echo "[forska] postgres is accepting connections"
      return 0
    fi

    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[forska] postgres process ($pid) exited early; see $log_file" >&2
      return 1
    fi

    sleep "$delay"
  done

  echo "[forska] postgres failed to become ready; see $log_file" >&2
  return 1
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local timeout="${3:-1200}"
  local tracked_pid="${4:-}"
  local interval=2
  local attempts=$((timeout / interval))

  echo "[forska] waiting for ${label} (${url}; timeout: ${timeout}s)..."

  for ((i=1; i<=attempts; i++)); do
    if curl -sf "$url" >/dev/null; then
      echo "[forska] ${label} is up (ready after $((i * interval))s)"
      return 0
    fi

    if [[ -n "$tracked_pid" ]] && ! kill -0 "$tracked_pid" 2>/dev/null; then
      echo "[forska] ${label} process (${tracked_pid}) exited early; check logs" >&2
      return 1
    fi

    if (( i % 15 == 0 )); then
      echo "[forska] still waiting for ${label}... ($((i * interval))s elapsed)"
    fi

    sleep "$interval"
  done

  echo "[forska] warning: ${label} did not respond on ${url} within ${timeout}s" >&2
  return 1
}

check_endpoint() {
  local label="$1"
  local url="$2"
  local code

  code=$(curl -sk -o /dev/null -w "%{http_code}" "$url" || echo "curl_error")
  echo "[forska] probe ${label} (${url}) -> http ${code}"
}

log_sglang_endpoints() {
  if [[ "${SGLANG_ENABLE_ROUTER}" == "1" ]]; then
    check_endpoint "router /v1/models" "http://localhost:${SGLANG_PORT}/v1/models"
    check_endpoint "router /get_model_info" "http://localhost:${SGLANG_PORT}/get_model_info"
  fi

  if [[ "${SGLANG_ONE_WORKER_PER_GPU}" == "1" ]]; then
    check_endpoint "worker[0] /v1/models" "http://localhost:${SGLANG_WORKER_PORT_BASE}/v1/models"
    check_endpoint "worker[0] /get_model_info" "http://localhost:${SGLANG_WORKER_PORT_BASE}/get_model_info"
  else
    check_endpoint "worker /v1/models" "http://localhost:${SGLANG_WORKER_PORT}/v1/models"
    check_endpoint "worker /get_model_info" "http://localhost:${SGLANG_WORKER_PORT}/get_model_info"
  fi
}

detect_tp_per_node() {
  local mems name total avg tp count

  if command -v nvidia-smi >/dev/null 2>&1; then
    mems=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | tr '\n' ' ')
    name=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)
  else
    mems=""
    name=""
  fi

  total=0
  count=0
  for mem in $mems; do
    total=$((total + mem))
    count=$((count + 1))
  done

  if (( count > 0 )); then
    avg=$((total / count))
  else
    avg=0
  fi

  if grep -qi 'A100' <<<"$name"; then
    if grep -qi 'fat' <<<"$name" || grep -qi '80' <<<"$name" || (( avg >= 76000 )); then
      tp=1
    else
      tp=2
    fi
    echo "$tp"
    return 0
  fi

  if grep -qi 'H200' <<<"$name" || (( avg >= 78000 )); then
    echo "1"
  else
    echo "2"
  fi
}

log_gpu_inventory() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "[forska] nvidia-smi not available; skipping GPU inventory log"
    return 0
  fi

  echo "[forska] GPU inventory (name, mem, uuid):"
  nvidia-smi --query-gpu=name,memory.total,uuid --format=csv
}

log_gpu_inventory

TOTAL_GPUS=$((NNODES * GPUS_PER_NODE))
TP_AUTO_DEFAULT=$(detect_tp_per_node)
REQUESTED_GPU_GRES_TYPE=${REQUESTED_GPU_GRES_TYPE:-}
if [[ -z "${REQUESTED_GPU_GRES_TYPE:-}" && -n "${SLURM_JOB_GRES:-}" && "${SLURM_JOB_GRES}" =~ gpu:([^,:]+) ]]; then
  REQUESTED_GPU_GRES_TYPE=${BASH_REMATCH[1]}
fi
export SGLANG_ONE_WORKER_PER_GPU=${SGLANG_ONE_WORKER_PER_GPU:-0}

if [[ "${SGLANG_ONE_WORKER_PER_GPU}" == "1" ]]; then
  TP_SIZE=1
  DP_SIZE=1
  GPUS_PER_ENGINE=1
  echo "[forska] per-GPU workers enabled: forcing tp=1, dp=1"
else
  if [[ -z "${TP_SIZE:-}" ]]; then
    if (( NNODES == 1 && GPUS_PER_NODE == 2 )) && [[ "${REQUESTED_GPU_GRES_TYPE:-}" == "A100fat" ]]; then
      TP_SIZE=2
      echo "[forska] defaulting to one 2-GPU engine: TP_SIZE=$TP_SIZE"
    elif (( NNODES == 1 && GPUS_PER_NODE == 4 )) && [[ "${REQUESTED_GPU_GRES_TYPE:-}" == "A100" ]]; then
      TP_SIZE=4
      echo "[forska] defaulting to one 4-GPU engine on A100: TP_SIZE=$TP_SIZE"
    else
      TP_SIZE=$TP_AUTO_DEFAULT
      echo "[forska] deriving TP from GPU type: TP_SIZE=$TP_SIZE"
    fi
  fi

  if (( TP_SIZE < 1 )); then
    echo "[forska] error: TP_SIZE must be >=1 (got $TP_SIZE)" >&2
    exit 2
  fi

  if (( GPUS_PER_NODE < TP_SIZE )); then
    echo "[forska] error: TP=${TP_SIZE} requires ${TP_SIZE} GPU(s) per node; only ${GPUS_PER_NODE} allocated per node" >&2
    exit 2
  fi

  if [[ -z "${DP_SIZE:-}" ]]; then
    if (( GPUS_PER_NODE % TP_SIZE == 0 )); then
      DP_SIZE=$((GPUS_PER_NODE / TP_SIZE))
      echo "[forska] deriving DP to fill node: DP_SIZE=$DP_SIZE"
    else
      DP_SIZE=1
      echo "[forska] warning: gpus_per_node (${GPUS_PER_NODE}) not divisible by tp (${TP_SIZE}); defaulting DP=1" >&2
    fi
  fi

  if (( DP_SIZE < 1 )); then
    DP_SIZE=1
  fi

  GPUS_PER_ENGINE=$((TP_SIZE * DP_SIZE))

  if (( GPUS_PER_ENGINE > GPUS_PER_NODE )); then
    echo "[forska] error: TP×DP=${GPUS_PER_ENGINE} exceeds GPUs per node (${GPUS_PER_NODE})" >&2
    exit 2
  fi
fi

GPU_MODEL_RAW=""
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_MODEL_RAW=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 || true)
fi

GPU_MODEL=$(sed -E \
  -e 's/[[:space:]]+Tensor[[:space:]]+Core//Ig' \
  -e 's/NVIDIA[[:space:]]+//Ig' \
  -e 's/[[:space:]]+GPU//Ig' \
  -e 's/[[:space:]]+PCIe//Ig' \
  -e 's/[[:space:]]+SXM[0-9A-Za-z-]*//Ig' \
  -e 's/[[:space:]]+[0-9]+GB//Ig' \
  -e 's/[[:space:]]+/ /g' \
  <<<"${GPU_MODEL_RAW}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')

if [[ -z "$GPU_MODEL" ]]; then
  GPU_MODEL="unknown"
fi

GPU_SHAPE="${GPU_MODEL}:${GPUS_PER_NODE}"
export GPU_SHAPE TP_SIZE DP_SIZE TOTAL_GPUS NNODES GPUS_PER_NODE GPUS_PER_ENGINE SGLANG_ONE_WORKER_PER_GPU

GPU_GRES_TYPE=${GPU_GRES_TYPE:-${REQUESTED_GPU_GRES_TYPE:-}}

if [[ -z "${GPU_GRES_TYPE:-}" ]]; then
  if grep -qi 'A100' <<<"$GPU_MODEL_RAW"; then
    if grep -qi 'fat' <<<"$GPU_MODEL_RAW" || grep -qi '80' <<<"$GPU_MODEL_RAW"; then
      GPU_GRES_TYPE=A100fat
    else
      GPU_GRES_TYPE=A100
    fi
  fi
fi

if [[ -n "${GPU_GRES_TYPE:-}" ]]; then
  SRUN_GPU_ARGS=(--gpus-per-task="${GPU_GRES_TYPE}:1")
else
  SRUN_GPU_ARGS=(--gpus-per-task=1)
fi

echo "[forska] topology: nodes=$NNODES, gpus/node=$GPUS_PER_NODE, total_gpus=$TOTAL_GPUS"
echo "[forska] sglang per-node: tp=$TP_SIZE, dp=$DP_SIZE (gpus_used_per_engine=$GPUS_PER_ENGINE)"
echo "[forska] srun GPU args: ${SRUN_GPU_ARGS[*]}"

export SGLANG_MODEL=${SGLANG_MODEL:-Qwen/Qwen3.5-35B-A3B}
export SGLANG_MAX_RUNNING_REQUESTS=${SGLANG_MAX_RUNNING_REQUESTS:-400}
export SGLANG_API_MAX_INFLIGHT_REQUESTS=${SGLANG_API_MAX_INFLIGHT_REQUESTS:-0}
export SGLANG_API_MAX_BURST_REQUESTS=${SGLANG_API_MAX_BURST_REQUESTS:-0}
export SGLANG_MEM_FRACTION=${SGLANG_MEM_FRACTION:-0.92}
export SGLANG_SCHEDULE_POLICY=${SGLANG_SCHEDULE_POLICY:-lpm}
export SGLANG_CHUNKED_PREFILL_SIZE=${SGLANG_CHUNKED_PREFILL_SIZE:-16384}
export SGLANG_CONTEXT_LENGTH=${SGLANG_CONTEXT_LENGTH:-0}

if [[ -z "${CUDA_VISIBLE_DEVICES:-}" && "${SGLANG_ONE_WORKER_PER_GPU}" != "1" && ${GPUS_PER_NODE:-0} -gt 0 ]]; then
  CUDA_VISIBLE_DEVICES=$(seq -s, 0 $((GPUS_PER_NODE - 1)))
  export CUDA_VISIBLE_DEVICES
fi

if [[ "${SGLANG_ONE_WORKER_PER_GPU}" == "1" ]]; then
  export SGLANG_ENABLE_ROUTER=${SGLANG_ENABLE_ROUTER:-1}
else
  export SGLANG_ENABLE_ROUTER=${SGLANG_ENABLE_ROUTER:-0}
fi

export SGLANG_ROUTER_POLICY=${SGLANG_ROUTER_POLICY:-round_robin}

if [[ "${SGLANG_ENABLE_ROUTER}" == "1" ]]; then
  export SGLANG_WORKER_PORT_BASE=${SGLANG_WORKER_PORT_BASE:-$((SGLANG_PORT + 1))}
  export SGLANG_WORKER_PORT=${SGLANG_WORKER_PORT:-$SGLANG_WORKER_PORT_BASE}
else
  export SGLANG_WORKER_PORT=${SGLANG_WORKER_PORT:-$SGLANG_PORT}
fi

build_worker_urls() {
  WORKER_URLS_ARRAY=()
  WORKER_URLS_LOCAL_ARRAY=()
  local local_index=0

  if [[ "${SGLANG_ONE_WORKER_PER_GPU}" == "1" ]]; then
    for node_host in "${HOSTS[@]}"; do
      for ((gpu_index=0; gpu_index<GPUS_PER_NODE; gpu_index++)); do
        WORKER_URLS_ARRAY+=("http://${node_host}:$((SGLANG_WORKER_PORT_BASE + gpu_index))")
        WORKER_URLS_LOCAL_ARRAY+=("http://localhost:$((SGLANG_LOCAL_PORT_BASE + local_index))")
        local_index=$((local_index + 1))
      done
    done
  else
    for node_host in "${HOSTS[@]}"; do
      WORKER_URLS_ARRAY+=("http://${node_host}:${SGLANG_WORKER_PORT}")
      WORKER_URLS_LOCAL_ARRAY+=("http://localhost:$((SGLANG_LOCAL_PORT_BASE + local_index))")
      local_index=$((local_index + 1))
    done
  fi

  WORKER_URLS_CSV=$(IFS=,; echo "${WORKER_URLS_ARRAY[*]}")
  WORKER_URLS_LOCAL_CSV=$(IFS=,; echo "${WORKER_URLS_LOCAL_ARRAY[*]}")
}

graceful_shutdown() {
  local reason="${1:-cleanup}"
  echo "[forska] shutting down (${reason})..."

  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" 2>/dev/null || true
    sleep 2 || true
    kill -KILL "$API_PID" 2>/dev/null || true
  fi

  if [[ -n "${APP_PID:-}" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    sleep 2 || true
    kill -KILL "$APP_PID" 2>/dev/null || true
  fi

  if [[ -n "${DB_PID:-}" ]] && kill -0 "$DB_PID" 2>/dev/null; then
    kill -TERM "$DB_PID" 2>/dev/null || true
    sleep 2 || true
    kill -KILL "$DB_PID" 2>/dev/null || true
  fi

  if [[ -n "${SGLANG_ROUTER_PID:-}" ]] && kill -0 "$SGLANG_ROUTER_PID" 2>/dev/null; then
    kill -TERM "$SGLANG_ROUTER_PID" 2>/dev/null || true
    sleep 2 || true
    kill -KILL "$SGLANG_ROUTER_PID" 2>/dev/null || true
  fi

  if [[ -n "${SGLANG_PID:-}" ]] && kill -0 "$SGLANG_PID" 2>/dev/null; then
    kill -TERM "$SGLANG_PID" 2>/dev/null || true
    sleep 2 || true
    kill -KILL "$SGLANG_PID" 2>/dev/null || true
  fi

  if [[ -n "${SGLANG_SRUN_PID:-}" ]] && kill -0 "$SGLANG_SRUN_PID" 2>/dev/null; then
    kill -TERM "$SGLANG_SRUN_PID" 2>/dev/null || true
    sleep 2 || true
    kill -KILL "$SGLANG_SRUN_PID" 2>/dev/null || true
  fi

  if [[ -n "$(jobs -pr)" ]]; then
    jobs -pr | xargs -r kill -TERM || true
    sleep 2 || true
    jobs -pr | xargs -r kill -KILL || true
  fi

  if [[ -n "${SGLANG_WORKER_DIR:-}" && -d "${SGLANG_WORKER_DIR}" ]]; then
    rm -f "${SGLANG_WORKER_DIR}/sglang-worker.sh" 2>/dev/null || true
    rmdir "${SGLANG_WORKER_DIR}" 2>/dev/null || true
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
DB_PID=$!

if ! wait_for_postgres "$DB_PID" "$LOG_DIR/db.log"; then
  echo "[forska] postgres failed to accept connections; aborting startup" >&2
  exit 2
fi

mkdir -p "$HF_HOME" "$SGLANG_CACHE_DIR"
build_worker_urls

echo "[forska] model=$SGLANG_MODEL"
echo "[forska] hf cache: $HF_HOME (downloads from Hugging Face on first run if missing)"
echo "[forska] router=${SGLANG_ENABLE_ROUTER} worker_urls=$WORKER_URLS_CSV"

if [[ "${SGLANG_ONE_WORKER_PER_GPU}" == "1" ]]; then
  echo "[forska] starting one SGLang worker per GPU"
  SGLANG_WORKER_DIR="$STACK_ROOT/.cache/sglang/${SLURM_JOB_ID:-manual}"
  SGLANG_WORKER_SCRIPT="$SGLANG_WORKER_DIR/sglang-worker.sh"
  mkdir -p "$SGLANG_WORKER_DIR"

  cat >"$SGLANG_WORKER_SCRIPT" <<'SGLANG_WORKER'
#!/usr/bin/env bash
set -euo pipefail

WORKER_IDX=${SLURM_LOCALID:-${LOCAL_RANK:-0}}
WORKER_PORT=$(( ${SGLANG_WORKER_PORT_BASE:-30001} + WORKER_IDX ))
CONTEXT_ARGS=()
if [[ "${SGLANG_CONTEXT_LENGTH:-0}" != "0" ]]; then
  CONTEXT_ARGS+=(--context-length "${SGLANG_CONTEXT_LENGTH}")
fi

exec apptainer exec --cleanenv --nv \
  --env HF_HOME=/hf_cache \
  --env HUGGINGFACE_HUB_CACHE=/hf_cache \
  --env HF_TOKEN="${HF_TOKEN:-}" \
  --env HUGGINGFACE_HUB_TOKEN="${HUGGINGFACE_HUB_TOKEN:-}" \
  --bind "$HF_HOME:/hf_cache:rw" \
  --env SGLANG_CACHE_DIR=/sg_cache \
  --bind "$SGLANG_CACHE_DIR:/sg_cache:rw" \
  "$SIF_SGLANG" \
  python -m sglang.launch_server \
    --model-path "$SGLANG_MODEL" \
    --host 0.0.0.0 --port "$WORKER_PORT" \
    --tensor-parallel-size 1 \
    --data-parallel-size 1 \
    --max-running-requests "$SGLANG_MAX_RUNNING_REQUESTS" \
    --chunked-prefill-size "$SGLANG_CHUNKED_PREFILL_SIZE" \
    --mem-fraction-static "$SGLANG_MEM_FRACTION" \
    --schedule-policy "$SGLANG_SCHEDULE_POLICY" \
    --enable-metrics \
    --download-dir /hf_cache \
    "${CONTEXT_ARGS[@]}"
SGLANG_WORKER

  chmod +x "$SGLANG_WORKER_SCRIPT"
  sync || true
  NODELIST=$(printf "%s," "${HOSTS[@]}" | sed 's/,$//')

  srun --nodes="$NNODES" \
    --ntasks-per-node="$GPUS_PER_NODE" \
    "${SRUN_GPU_ARGS[@]}" \
    --gpu-bind=single:1 \
    --nodelist="$NODELIST" \
    --export=ALL \
    --output "$LOG_DIR/sglang-%N-%t.log" \
    bash -lc "$SGLANG_WORKER_SCRIPT" &
  SGLANG_SRUN_PID=$!
else
  CONTEXT_ARGS=()
  if [[ "${SGLANG_CONTEXT_LENGTH}" != "0" ]]; then
    CONTEXT_ARGS+=(--context-length "$SGLANG_CONTEXT_LENGTH")
  fi

  if [[ $NNODES -gt 1 ]]; then
    echo "[forska] starting independent SGLang worker per node (tp=$TP_SIZE, dp=$DP_SIZE)"
    SGLANG_WORKER_DIR="$STACK_ROOT/.cache/sglang/${SLURM_JOB_ID:-manual}"
    SGLANG_WORKER_SCRIPT="$SGLANG_WORKER_DIR/sglang-worker.sh"
    mkdir -p "$SGLANG_WORKER_DIR"

    cat >"$SGLANG_WORKER_SCRIPT" <<'SGLANG_WORKER'
#!/usr/bin/env bash
set -euo pipefail

CONTEXT_ARGS=()
if [[ "${SGLANG_CONTEXT_LENGTH:-0}" != "0" ]]; then
  CONTEXT_ARGS+=(--context-length "${SGLANG_CONTEXT_LENGTH}")
fi

exec apptainer exec --cleanenv --nv \
  --env HF_HOME=/hf_cache \
  --env HUGGINGFACE_HUB_CACHE=/hf_cache \
  --env HF_TOKEN="${HF_TOKEN:-}" \
  --env HUGGINGFACE_HUB_TOKEN="${HUGGINGFACE_HUB_TOKEN:-}" \
  --bind "$HF_HOME:/hf_cache:rw" \
  --env SGLANG_CACHE_DIR=/sg_cache \
  --bind "$SGLANG_CACHE_DIR:/sg_cache:rw" \
  "$SIF_SGLANG" \
  python -m sglang.launch_server \
    --model-path "$SGLANG_MODEL" \
    --host 0.0.0.0 --port "$SGLANG_WORKER_PORT" \
    --tensor-parallel-size "$TP_SIZE" \
    --data-parallel-size "$DP_SIZE" \
    --max-running-requests "$SGLANG_MAX_RUNNING_REQUESTS" \
    --chunked-prefill-size "$SGLANG_CHUNKED_PREFILL_SIZE" \
    --mem-fraction-static "$SGLANG_MEM_FRACTION" \
    --schedule-policy "$SGLANG_SCHEDULE_POLICY" \
    --enable-metrics \
    --download-dir /hf_cache \
    "${CONTEXT_ARGS[@]}"
SGLANG_WORKER

    chmod +x "$SGLANG_WORKER_SCRIPT"
    sync || true
    NODELIST=$(printf "%s," "${HOSTS[@]}" | sed 's/,$//')

    srun --nodes="$NNODES" --ntasks="$NNODES" \
      --nodelist="$NODELIST" \
      --export=ALL \
      --output "$LOG_DIR/sglang-%N.log" \
      bash -lc "$SGLANG_WORKER_SCRIPT" &
    SGLANG_SRUN_PID=$!
  else
    echo "[forska] starting SGLang on single node (tp=$TP_SIZE, dp=$DP_SIZE)"
    apptainer exec --cleanenv --nv \
      --env HF_HOME=/hf_cache \
      --env HUGGINGFACE_HUB_CACHE=/hf_cache \
      --env HF_TOKEN="${HF_TOKEN:-}" \
      --env HUGGINGFACE_HUB_TOKEN="${HUGGINGFACE_HUB_TOKEN:-}" \
      --bind "$HF_HOME:/hf_cache:rw" \
      --env SGLANG_CACHE_DIR=/sg_cache \
      --bind "$SGLANG_CACHE_DIR:/sg_cache:rw" \
      "$SIF_SGLANG" \
      python -m sglang.launch_server \
        --model-path "$SGLANG_MODEL" \
        --host 0.0.0.0 --port "$SGLANG_WORKER_PORT" \
        --tensor-parallel-size "$TP_SIZE" \
        --data-parallel-size "$DP_SIZE" \
        --max-running-requests "$SGLANG_MAX_RUNNING_REQUESTS" \
        --chunked-prefill-size "$SGLANG_CHUNKED_PREFILL_SIZE" \
        --mem-fraction-static "$SGLANG_MEM_FRACTION" \
        --schedule-policy "$SGLANG_SCHEDULE_POLICY" \
        --enable-metrics \
        --download-dir /hf_cache \
        "${CONTEXT_ARGS[@]}" \
      >"$LOG_DIR/sglang.log" 2>&1 &
    SGLANG_PID=$!
  fi
fi

WORKER_WAIT_PID="${SGLANG_PID:-${SGLANG_SRUN_PID:-}}"
if [[ "${SGLANG_ONE_WORKER_PER_GPU}" == "1" ]]; then
  wait_for_http "SGLang worker[0]" "http://localhost:${SGLANG_WORKER_PORT_BASE}/v1/models" 1200 "$WORKER_WAIT_PID" || true
else
  wait_for_http "SGLang worker" "http://localhost:${SGLANG_WORKER_PORT}/v1/models" 1200 "$WORKER_WAIT_PID" || true
fi

if [[ "${SGLANG_ENABLE_ROUTER}" == "1" ]]; then
  if [[ -z "${SGLANG_ROUTER_WORKER_URLS:-}" ]]; then
    SGLANG_ROUTER_WORKER_URLS="${WORKER_URLS_CSV//,/ }"
  fi

  read -r -a ROUTER_WORKERS <<<"${SGLANG_ROUTER_WORKER_URLS}"

  if (( ${#ROUTER_WORKERS[@]} == 0 )); then
    echo "[forska] error: router enabled but no worker URLs found" >&2
    exit 2
  fi

  echo "[forska] starting SGLang router on :$SGLANG_PORT (policy=${SGLANG_ROUTER_POLICY})"
  apptainer exec --cleanenv \
    "$SIF_SGLANG" \
    python -m sglang_router.launch_router \
      --host 0.0.0.0 \
      --port "$SGLANG_PORT" \
      --policy "$SGLANG_ROUTER_POLICY" \
      --worker-urls "${ROUTER_WORKERS[@]}" \
    >"$LOG_DIR/sglang-router.log" 2>&1 &
  SGLANG_ROUTER_PID=$!
  wait_for_http "SGLang router" "http://localhost:${SGLANG_PORT}/v1/models" 600 "$SGLANG_ROUTER_PID" || true
else
  echo "[forska] router disabled; worker is serving directly on :$SGLANG_PORT"
fi

log_sglang_endpoints

API_BINDS=(--bind "$DB_URL_FILE:/run/secrets/database_url:ro")
[[ -f "$BA_SECRET_FILE" ]] && API_BINDS+=(--bind "$BA_SECRET_FILE:/run/secrets/better_auth_secret:ro")
[[ -f "$BA_URL_FILE" ]] && API_BINDS+=(--bind "$BA_URL_FILE:/run/secrets/better_auth_url:ro")

API_ENVS=(--env DATABASE_URL_FILE=/run/secrets/database_url)
[[ -f "$BA_SECRET_FILE" ]] && API_ENVS+=(--env BETTER_AUTH_SECRET_FILE=/run/secrets/better_auth_secret)
[[ -f "$BA_URL_FILE" ]] && API_ENVS+=(--env BETTER_AUTH_URL_FILE=/run/secrets/better_auth_url)

echo "[forska] starting API on :$API_SERVER_PORT"

apptainer run --cleanenv \
  "${API_BINDS[@]}" \
  "${API_ENVS[@]}" \
  --env BUN_CONFIG_MAX_HTTP_REQUESTS="${BUN_CONFIG_MAX_HTTP_REQUESTS:-1024}" \
  --env VITE_LLM_SERVER_URL="$VITE_LLM_SERVER_URL" \
  --env VITE_SERVER_API="http://localhost:${API_SERVER_PORT}" \
  --env API_SERVER_PORT="$API_SERVER_PORT" \
  --env VITE_PORT="$VITE_PORT" \
  --env GPU_NNODES="$NNODES" \
  --env GPU_GPUS_PER_NODE="$GPUS_PER_NODE" \
  --env GPU_SHAPE="$GPU_SHAPE" \
  --env GPU_TOTAL_GPUS="$TOTAL_GPUS" \
  --env TP_SIZE="$TP_SIZE" \
  --env DP_SIZE="$DP_SIZE" \
  --env SGLANG_MAX_RUNNING_REQUESTS="$SGLANG_MAX_RUNNING_REQUESTS" \
  --env SGLANG_API_MAX_INFLIGHT_REQUESTS="$SGLANG_API_MAX_INFLIGHT_REQUESTS" \
  --env SGLANG_API_MAX_BURST_REQUESTS="$SGLANG_API_MAX_BURST_REQUESTS" \
  --env SGLANG_CHUNKED_PREFILL_SIZE="$SGLANG_CHUNKED_PREFILL_SIZE" \
  --env SGLANG_CONTEXT_LENGTH="$SGLANG_CONTEXT_LENGTH" \
  --env SGLANG_MODEL="$SGLANG_MODEL" \
  --env WORKER_URLS="$WORKER_URLS_CSV" \
  --env OPENALEX_MAILTO="fredrik.carlsson@gu.se" \
  "$SIF_API" \
  >"$LOG_DIR/api.log" 2>&1 &
API_PID=$!

echo "[forska] starting app on :$PROD_SERVER (proxies to API :$API_SERVER_PORT)"

apptainer run --cleanenv \
  --env SERVER_HOST=localhost \
  --env API_SERVER_PORT="$API_SERVER_PORT" \
  --env PROD_SERVER="$PROD_SERVER" \
  --env GPU_NNODES="$NNODES" \
  --env GPU_GPUS_PER_NODE="$GPUS_PER_NODE" \
  --env GPU_TOTAL_GPUS="$TOTAL_GPUS" \
  --env TP_SIZE="$TP_SIZE" \
  --env DP_SIZE="$DP_SIZE" \
  "$SIF_APP" \
  >"$LOG_DIR/app.log" 2>&1 &
APP_PID=$!

echo "[forska] services launched"
echo "  host:        $(hostname)"
echo "  postgres:    127.0.0.1:$POSTGRES_PORT"
echo "  sglang:      http://127.0.0.1:${SGLANG_PORT}/v1"
echo "  dist:        ${NNODES} node(s) x ${GPUS_PER_NODE} GPU(s) = $((NNODES * GPUS_PER_NODE)) (tp=${TP_SIZE}, dp=${DP_SIZE})"
echo "  api:         http://127.0.0.1:$API_SERVER_PORT"
echo "  app:         http://127.0.0.1:$PROD_SERVER"
echo "  workers:     $WORKER_URLS_CSV"
echo "  local ports: $WORKER_URLS_LOCAL_CSV"
echo "[forska] tail logs in: $LOG_DIR"
echo "[forska] for ssh tunnel to postgres"
echo "  ssh -N -L 8432:$(hostname):$POSTGRES_PORT alvis2"
echo "[forska] for ssh tunnel to the api"
echo "  ssh -N -L 3001:$(hostname):$API_SERVER_PORT alvis2"
echo "[forska] for ssh tunnel to the sglang router"
echo "  ssh -N -L ${SGLANG_PORT}:$(hostname):${SGLANG_PORT} alvis2"

echo ""
echo "[alvis:config:start]"
echo "SGLANG_HOST=$(hostname)"
echo "SGLANG_PORT=$SGLANG_PORT"
echo "SGLANG_INTERNAL_PORT=$SGLANG_PORT"
echo "CADDY_PORT=$SGLANG_PORT"
echo "SGLANG_WORKER_PORT=$SGLANG_WORKER_PORT"
echo "SGLANG_MODEL=$SGLANG_MODEL"
echo "WORKER_URLS=$WORKER_URLS_CSV"
echo "WORKER_URLS_LOCAL=$WORKER_URLS_LOCAL_CSV"
echo "NNODES=$NNODES"
echo "GPUS_PER_NODE=$GPUS_PER_NODE"
echo "TP_SIZE=$TP_SIZE"
echo "DP_SIZE=$DP_SIZE"
echo "SGLANG_ONE_WORKER_PER_GPU=$SGLANG_ONE_WORKER_PER_GPU"
echo "SGLANG_ENABLE_ROUTER=${SGLANG_ENABLE_ROUTER:-0}"
echo "SGLANG_MAX_RUNNING_REQUESTS=$SGLANG_MAX_RUNNING_REQUESTS"
echo "SGLANG_API_MAX_INFLIGHT_REQUESTS=$SGLANG_API_MAX_INFLIGHT_REQUESTS"
echo "SGLANG_API_MAX_BURST_REQUESTS=$SGLANG_API_MAX_BURST_REQUESTS"
echo "SGLANG_CHUNKED_PREFILL_SIZE=$SGLANG_CHUNKED_PREFILL_SIZE"
echo "SGLANG_CONTEXT_LENGTH=$SGLANG_CONTEXT_LENGTH"
echo "SGLANG_LOCAL_PORT_BASE=$SGLANG_LOCAL_PORT_BASE"
echo "[alvis:config:end]"

wait
