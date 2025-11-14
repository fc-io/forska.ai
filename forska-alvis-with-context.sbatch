#!/bin/bash
#SBATCH -J forska-alvis
#SBATCH -A NAISS2025-22-715 -p alvis
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-node=A100:4
#SBATCH --time=08:00:00
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
export STACK_ROOT=${STACK_ROOT:-/mimer/NOBACKUP/groups/clin-agent-bench/dev}
mkdir -p "$STACK_ROOT"/{pgdata,hf_cache,logs,.cache,.secrets}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$STACK_ROOT/.cache}
export HF_HOME=${HF_HOME:-$STACK_ROOT/hf_cache}
export SGLANG_CACHE_DIR=${SGLANG_CACHE_DIR:-$XDG_CACHE_HOME/sglang}
export SGLANG_CONTEXT_LENGTH=${SGLANG_CONTEXT_LENGTH:-8192}

# Service ports (host networking)
export POSTGRES_PORT=${POSTGRES_PORT:-5432}
export API_SERVER_PORT=${API_SERVER_PORT:-3001}
export PROD_SERVER=${PROD_SERVER:-8181}
export SGLANG_PORT=${SGLANG_PORT:-30000}

# GPU shape overrides used to compute DP/TP; Slurm allocation must match
# Autodetect GPUs per node from Slurm if available; override via --export GPUS_PER_NODE=<n>
export GPUS_PER_NODE=${GPUS_PER_NODE:-${SLURM_GPUS_ON_NODE:-2}}
# NCCL tuning hints (override via --export as needed)
export NCCL_DEBUG=${NCCL_DEBUG:-WARN}
export NCCL_ASYNC_ERROR_HANDLING=${NCCL_ASYNC_ERROR_HANDLING:-1}
# If your cluster requires a specific NIC/Infiniband device, uncomment and set:
# export NCCL_SOCKET_IFNAME=${NCCL_SOCKET_IFNAME:-ib0}
# export NCCL_IB_HCA=${NCCL_IB_HCA:-mlx5_0}
# export NCCL_IB_GID_INDEX=${NCCL_IB_GID_INDEX:-3}

# Client/API URLs used by the compiled servers
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

# Preflight
need() { [ -f "$1" ] || { echo "[forska] missing: $1" >&2; exit 2; }; }
need "$SIF_DB"; need "$SIF_SGLANG"; need "$SIF_API"; need "$SIF_APP"; need "$DB_PW_FILE"; need "$DB_URL_FILE"

LOG_DIR="$STACK_ROOT/logs/${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

# Multi-node topology (no Ray)
NNODES=${NNODES:-${SLURM_NNODES:-1}}
HOSTS=( $(scontrol show hostnames "${SLURM_NODELIST:-$(hostname -s)}") )
HEAD_NODE=${HOSTS[0]:-$(hostname -s)}
THIS_NODE=$(hostname -s)
WORKER_NODES=( "${HOSTS[@]:1}" )

find_free_port() {
  local min=${1:-19000}
  local max=${2:-19999}
  local p n listening
  n=$(( max - min + 1 ))
  (( n >= 1 )) || { echo "[forska] bad port range: $min-$max" >&2; return 2; }
  listening=$(ss -H -ltn 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -u)
  for p in $(shuf -i "$min-$max" -n "$n"); do
    if grep -qx "$p" <<<"$listening"; then continue; fi
    echo "$p"; return 0
  done
  return 1
}

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
  local log="$2"
  local attempts=${POSTGRES_READY_ATTEMPTS:-60}
  local delay=${POSTGRES_READY_DELAY:-2}
  local elapsed=$(( attempts * delay ))

  for ((i=1; i<=attempts; i++)); do
    if postgres_ping; then
      echo "[forska] postgres is accepting connections"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[forska] postgres process ($pid) exited early; see $log" >&2
      return 1
    fi
    sleep "$delay"
  done

  echo "[forska] postgres failed to become ready within ${elapsed}s; see $log" >&2
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
      local elapsed=$((i * interval))
      echo "[forska] ${label} is up (ready after ${elapsed}s)"
      return 0
    fi
    if [[ -n "$tracked_pid" ]] && ! kill -0 "$tracked_pid" 2>/dev/null; then
      echo "[forska] ${label} process (${tracked_pid}) exited early; check logs" >&2
      return 1
    fi
    if (( i % 15 == 0 )); then
      local elapsed=$((i * interval))
      local remaining=$((timeout - elapsed))
      echo "[forska] still waiting for ${label}... (${elapsed}s elapsed, ${remaining}s remaining)"
    fi
    sleep "$interval"
  done
  echo "[forska] warning: ${label} did not respond on ${url} within ${timeout}s" >&2
  return 1
}



# Resolve an IPv4 address for the head node that workers can reach.
# Avoid IPv6 (Ray may parse "host:port" incorrectly for IPv6 without brackets).
# Try DNS for IPv4 first, then fall back to the first local IPv4.
if [[ -z "${HEAD_IP:-}" ]]; then
  if command -v getent >/dev/null 2>&1; then
    HEAD_IP=$(getent ahostsv4 "$HEAD_NODE" | awk '{print $1; exit}')
  fi
  if [[ -z "${HEAD_IP:-}" ]]; then
    HEAD_IP=$(hostname -I | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$' || true)
  fi
fi
if [[ -z "${HEAD_IP:-}" ]]; then
  echo "[forska] error: unable to resolve an IPv4 address for head node '$HEAD_NODE'." >&2
  echo "         Set HEAD_IP=<ipv4> when submitting: sbatch --export=ALL,HEAD_IP=1.2.3.4 forska-alvis.sbatch" >&2
  exit 2
fi
echo "[forska] resolved HEAD_IP=$HEAD_IP for head node $HEAD_NODE"

# Test if HEAD_IP is reachable from this node
if ! ping -c 1 -W 2 "$HEAD_IP" >/dev/null 2>&1; then
  echo "[forska] warning: HEAD_IP $HEAD_IP is not pingable from $(hostname)" >&2
  echo "[forska]          This may cause distributed connectivity issues in multi-node setup" >&2
fi

# Choose tensor parallel per node based on GPU memory/type.
detect_tp_per_node() {
  local mems name total avg tp
  if command -v nvidia-smi >/dev/null 2>&1; then
    mems=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | tr '\n' ' ')
    name=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)
  else
    mems=""; name=""
  fi
  total=0; count=0
  for m in $mems; do total=$((total + m)); count=$((count + 1)); done
  if (( count > 0 )); then avg=$(( total / count )); else avg=0; fi
  if grep -qi 'H200' <<<"$name"; then
    tp=1
  elif (( avg >= 78000 )); then
    tp=1
  else
    tp=2
  fi
  echo "$tp"
}

TOTAL_GPUS=$(( NNODES * GPUS_PER_NODE ))
TP_AUTO_DEFAULT=$(detect_tp_per_node)
if [[ -z "${TP_SIZE:-}" ]]; then
  TP_SIZE=$TP_AUTO_DEFAULT
  echo "[forska] deriving TP from GPU type: TP_SIZE=$TP_SIZE"
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
    DP_SIZE=$(( GPUS_PER_NODE / TP_SIZE ))
    if (( DP_SIZE < 1 )); then DP_SIZE=1; fi
    echo "[forska] deriving DP to fill node: DP_SIZE=$DP_SIZE"
  else
    DP_SIZE=1
    echo "[forska] warning: gpus_per_node (${GPUS_PER_NODE}) not divisible by tp (${TP_SIZE}); defaulting DP=1 (some GPUs idle)" >&2
  fi
fi
if (( DP_SIZE < 1 )); then DP_SIZE=1; fi
GPUS_PER_ENGINE=$(( TP_SIZE * DP_SIZE ))
if (( GPUS_PER_ENGINE > GPUS_PER_NODE )); then
  echo "[forska] error: TP×DP=${GPUS_PER_ENGINE} exceeds GPUs per node (${GPUS_PER_NODE}); lower DP_SIZE or TP_SIZE" >&2
  exit 2
fi
if (( GPUS_PER_ENGINE < GPUS_PER_NODE )); then
  UNUSED=$(( GPUS_PER_NODE - GPUS_PER_ENGINE ))
  echo "[forska] note: ${UNUSED} GPU(s) per node will remain idle (tp=${TP_SIZE}, dp=${DP_SIZE}). Adjust TP_SIZE/DP_SIZE or #SBATCH to match."
fi
echo "[forska] topology: nodes=$NNODES, gpus/node=$GPUS_PER_NODE, total_gpus=$TOTAL_GPUS"
echo "[forska] sglang parallelism per node: tp=$TP_SIZE, dp=$DP_SIZE (gpus_used_per_node=$GPUS_PER_ENGINE)"
export TP_SIZE DP_SIZE TOTAL_GPUS NNODES GPUS_PER_NODE GPUS_PER_ENGINE

# If user did not set an explicit concurrency cap, default to 256 per engine.
if [[ -z "${SGLANG_MAX_RUNNING_REQUESTS:-}" ]]; then
  SGLANG_MAX_RUNNING_REQUESTS=256
  echo "[forska] defaulting max-running-requests to $SGLANG_MAX_RUNNING_REQUESTS (per engine)"
fi

# Propagate CUDA_VISIBLE_DEVICES into containers so NVML sees only the GPUs assigned on this node.
if [[ -z "${CUDA_VISIBLE_DEVICES:-}" && ${GPUS_PER_NODE:-0} -gt 0 ]]; then
  CUDA_VISIBLE_DEVICES=$(seq -s, 0 $((GPUS_PER_NODE - 1)))
  export CUDA_VISIBLE_DEVICES
  echo "[forska] defaulting CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES"
elif [[ -n "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  export CUDA_VISIBLE_DEVICES
  echo "[forska] detected CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES"
else
  echo "[forska] CUDA_VISIBLE_DEVICES is unset; downstream containers may enumerate all visible GPUs"
fi

# Derive a descriptive GPU shape string for logging (e.g., "A100:4")
GPU_MODEL_RAW=""
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_MODEL_RAW=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 || true)
fi
# Normalize common NVIDIA name suffixes for a compact identifier
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
export GPU_SHAPE

graceful_shutdown() {
  local reason="${1:-cleanup}"
  echo "[forska] shutting down ($reason)..."

  # Ordered shutdown: API → Postgres → Ray → everything else

  # 1. Stop API server first (needs DB connection, so shut down before Postgres)
  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    echo "[forska] stopping API server (pid=$API_PID)..."
    kill -TERM "$API_PID" 2>/dev/null || true
    for ((i=0; i<10; i++)); do
      kill -0 "$API_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$API_PID" 2>/dev/null; then
      echo "[forska] force-killing API server"
      kill -KILL "$API_PID" 2>/dev/null || true
    fi
  fi

  # 2. Stop App server
  if [[ -n "${APP_PID:-}" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "[forska] stopping App server (pid=$APP_PID)..."
    kill -TERM "$APP_PID" 2>/dev/null || true
    for ((i=0; i<10; i++)); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -KILL "$APP_PID" 2>/dev/null || true
    fi
  fi

  # 3. Stop Postgres (after API no longer needs it)
  if [[ -n "${DB_PID:-}" ]] && kill -0 "$DB_PID" 2>/dev/null; then
    echo "[forska] stopping Postgres (pid=$DB_PID)..."
    kill -TERM "$DB_PID" 2>/dev/null || true
    for ((i=0; i<10; i++)); do
      kill -0 "$DB_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$DB_PID" 2>/dev/null; then
      echo "[forska] force-killing Postgres"
      kill -KILL "$DB_PID" 2>/dev/null || true
    fi
  fi

  # 4. Stop SGLang and any distributed workers
  if [[ -n "${SGLANG_ROUTER_PID:-}" ]] && kill -0 "$SGLANG_ROUTER_PID" 2>/dev/null; then
    echo "[forska] stopping SGLang router (pid=$SGLANG_ROUTER_PID)..."
    kill -TERM "$SGLANG_ROUTER_PID" 2>/dev/null || true
    sleep 2 || true
    kill -KILL "$SGLANG_ROUTER_PID" 2>/dev/null || true
  fi
  if [[ -n "${SGLANG_PID:-}" ]] && kill -0 "$SGLANG_PID" 2>/dev/null; then
    echo "[forska] stopping SGLang (pid=$SGLANG_PID)..."
    kill -TERM "$SGLANG_PID" 2>/dev/null || true
  fi
  if [[ -n "${SGLANG_SRUN_PID:-}" ]] && kill -0 "$SGLANG_SRUN_PID" 2>/dev/null; then
    echo "[forska] stopping distributed SGLang workers (srun pid=$SGLANG_SRUN_PID)..."
    kill -TERM "$SGLANG_SRUN_PID" 2>/dev/null || true
    sleep 2 || true
    kill -KILL "$SGLANG_SRUN_PID" 2>/dev/null || true
  fi

  # Clean up any remaining backgrounded processes
  if [[ -n "$(jobs -pr)" ]]; then
    echo "[forska] cleaning up remaining background processes..."
    jobs -pr | xargs -r kill -TERM || true
    for ((i=0; i<10; i++)); do
      [[ -z "$(jobs -pr)" ]] && break
      sleep 1
    done
    if [[ -n "$(jobs -pr)" ]]; then
      jobs -pr | xargs -r kill -KILL || true
    fi
  fi
  # Remove per-job worker script to avoid collisions across runs
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

############################################
# Start SGLang server (single or multi-node)
############################################

export SGLANG_MODEL=${SGLANG_MODEL:-Qwen/Qwen3-30B-A3B-Instruct-2507}
export SGLANG_MAX_RUNNING_REQUESTS
export SGLANG_MEM_FRACTION=${SGLANG_MEM_FRACTION:-0.92}
export SGLANG_SCHEDULE_POLICY=${SGLANG_SCHEDULE_POLICY:-lpm}
export SGLANG_ENABLE_ROUTER=${SGLANG_ENABLE_ROUTER:-1}
export SGLANG_ROUTER_POLICY=${SGLANG_ROUTER_POLICY:-cache_aware}
if [[ "${SGLANG_ENABLE_ROUTER}" == "1" ]]; then
  export SGLANG_WORKER_PORT=${SGLANG_WORKER_PORT:-$((SGLANG_PORT + 1))}
else
  export SGLANG_WORKER_PORT=${SGLANG_PORT}
fi

mkdir -p "${HF_HOME}" "${SGLANG_CACHE_DIR}"

if [[ $NNODES -gt 1 ]]; then
  echo "[forska] starting independent SGLang worker per node (tp=$TP_SIZE, dp=$DP_SIZE)"
  # Use a per-job path to avoid ETXTBUSY if another job is executing the same script
  SGLANG_WORKER_DIR="$STACK_ROOT/.cache/sglang/${SLURM_JOB_ID:-manual}"
  SGLANG_WORKER_SCRIPT="$SGLANG_WORKER_DIR/sglang-worker.sh"
  mkdir -p "$SGLANG_WORKER_DIR"
  cat >"$SGLANG_WORKER_SCRIPT" <<'SGLANG_WORKER'
#!/usr/bin/env bash
set -euo pipefail
exec apptainer exec --cleanenv --nv \
  --env HF_HOME=/hf_cache \
  --bind "$HF_HOME:/hf_cache:rw" \
  --env SGLANG_CACHE_DIR=/sg_cache \
  --bind "$SGLANG_CACHE_DIR:/sg_cache:rw" \
  "${SIF_SGLANG}" \
  python -m sglang.launch_server \
    --model-path "${SGLANG_MODEL}" \
    --host 0.0.0.0 --port "${SGLANG_WORKER_PORT}" \
    --context-length "${SGLANG_CONTEXT_LENGTH}" \
    --tensor-parallel-size "${TP_SIZE}" \
    --data-parallel-size "${DP_SIZE}" \
    --max-running-requests "${SGLANG_MAX_RUNNING_REQUESTS}" \
    --mem-fraction-static "${SGLANG_MEM_FRACTION}" \
    --schedule-policy "${SGLANG_SCHEDULE_POLICY}" \
    --enable-metrics \
    --download-dir /hf_cache
SGLANG_WORKER
  chmod +x "$SGLANG_WORKER_SCRIPT"
  # Help network FS flush metadata before distributed exec
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
    --bind "$HF_HOME:/hf_cache:rw" \
    --env SGLANG_CACHE_DIR=/sg_cache \
    --bind "$SGLANG_CACHE_DIR:/sg_cache:rw" \
    "$SIF_SGLANG" \
    python -m sglang.launch_server \
      --model-path "$SGLANG_MODEL" \
      --host 0.0.0.0 --port "$SGLANG_WORKER_PORT" \
      --context-length "$SGLANG_CONTEXT_LENGTH" \
      --tensor-parallel-size "$TP_SIZE" \
      --data-parallel-size "$DP_SIZE" \
      --max-running-requests "$SGLANG_MAX_RUNNING_REQUESTS" \
      --mem-fraction-static "$SGLANG_MEM_FRACTION" \
      --schedule-policy "$SGLANG_SCHEDULE_POLICY" \
      --enable-metrics \
      --download-dir /hf_cache \
    >"$LOG_DIR/sglang.log" 2>&1 &
  SGLANG_PID=$!
fi

WORKER_WAIT_PID="${SGLANG_PID:-${SGLANG_SRUN_PID:-}}"
wait_for_http "SGLang worker" "http://localhost:${SGLANG_WORKER_PORT}/v1/models" 1200 "$WORKER_WAIT_PID" || true

if [[ "${SGLANG_ENABLE_ROUTER}" == "1" ]]; then
  if [[ -z "${SGLANG_ROUTER_WORKER_URLS:-}" ]]; then
    ROUTER_WORKERS_AUTO=()
    if [[ $NNODES -gt 1 ]]; then
      for node_host in "${HOSTS[@]}"; do
        ROUTER_WORKERS_AUTO+=("http://${node_host}:${SGLANG_WORKER_PORT}")
      done
    else
      ROUTER_WORKERS_AUTO+=("http://127.0.0.1:${SGLANG_WORKER_PORT}")
    fi
    SGLANG_ROUTER_WORKER_URLS="${ROUTER_WORKERS_AUTO[*]}"
    unset -v ROUTER_WORKERS_AUTO
    echo "[forska] router workers: ${SGLANG_ROUTER_WORKER_URLS}"
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

WORKER_URLS_CSV=${SGLANG_ROUTER_WORKER_URLS:-}
WORKER_URLS_CSV=${WORKER_URLS_CSV// /,}

# Start API
API_BINDS=(
  --bind "$DB_URL_FILE:/run/secrets/database_url:ro"
)
[[ -f "$BA_SECRET_FILE" ]] && API_BINDS+=(--bind "$BA_SECRET_FILE:/run/secrets/better_auth_secret:ro")
[[ -f "$BA_URL_FILE" ]] && API_BINDS+=(--bind "$BA_URL_FILE:/run/secrets/better_auth_url:ro")

echo "[forska] starting API on :$API_SERVER_PORT"
# Only pass optional Better Auth envs if corresponding files exist
API_ENVS=(--env DATABASE_URL_FILE=/run/secrets/database_url)
[[ -f "$BA_SECRET_FILE" ]] && API_ENVS+=(--env BETTER_AUTH_SECRET_FILE=/run/secrets/better_auth_secret)
[[ -f "$BA_URL_FILE" ]] && API_ENVS+=(--env BETTER_AUTH_URL_FILE=/run/secrets/better_auth_url)

apptainer run --cleanenv \
  "${API_BINDS[@]}" \
  "${API_ENVS[@]}" \
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
  --env SGLANG_CONTEXT_LENGTH="$SGLANG_CONTEXT_LENGTH" \
  --env SGLANG_MAX_RUNNING_REQUESTS="$SGLANG_MAX_RUNNING_REQUESTS" \
  --env SGLANG_MODEL="$SGLANG_MODEL" \
  --env WORKER_URLS="$WORKER_URLS_CSV" \
  "$SIF_API" \
  >"$LOG_DIR/api.log" 2>&1 &
API_PID=$!

# Start App
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
if [[ $NNODES -gt 1 ]]; then
  echo "  head node:   ${HEAD_NODE} (${HEAD_IP})"
  echo "  nodes:       ${HOSTS[*]}"
fi
echo "  dist:        ${NNODES} node(s) × ${GPUS_PER_NODE} GPU(s) = $((NNODES*GPUS_PER_NODE)) (tp=${TP_SIZE}, dp=${DP_SIZE})"
echo "  api:         http://127.0.0.1:$API_SERVER_PORT"
echo "  app:         http://127.0.0.1:$PROD_SERVER"
echo "[forska] tail logs in: $LOG_DIR"
echo "[forska] for ssh tunnel to postgres"
echo "  ssh -N -L 8432:$(hostname):$POSTGRES_PORT alvis2"
echo "[forska] for ssh tunnel to the api"
echo "  ssh -N -L 3001:$(hostname):$API_SERVER_PORT alvis2"
echo "[forska] for ssh tunnel to the sglang server"
echo "  ssh -N -L ${SGLANG_PORT}:$(hostname):${SGLANG_PORT} alvis2"

# Block until all background services exit
wait
