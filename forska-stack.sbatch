#!/bin/bash
#SBATCH -J forska-stack
#SBATCH -A NAISS2025-22-715 -p alvis
#SBATCH --nodes=2
# Use one task per node; matches multi-node Ray layout
# (avoid --ntasks=1 which triggers Slurm's node/task mismatch warning)
#SBATCH --ntasks-per-node=1
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
# Ray ports: allow user override; otherwise, pick free ports on the head
# within a preferred range. This avoids collisions and works with HPC firewalls
# when the range is pre-approved.
PREFERRED_MIN=${RAY_PREFERRED_MIN:-8888}
PREFERRED_MAX=${RAY_PREFERRED_MAX:-9200}

# Cache of already-chosen ports within this script to avoid duplicates
declare -ag _RESERVED_PORTS=()

find_free_port() {
  local min=${1:-$PREFERRED_MIN}
  local max=${2:-$PREFERRED_MAX}
  local p n listening

  # Validate and size the search space
  n=$(( max - min + 1 ))
  (( n >= 1 )) || { echo "[forska] bad port range: $min-$max" >&2; return 2; }

  # Cache the set of in-use TCP listen ports for this call
  listening=$(ss -H -ltn 2>/dev/null \
    | awk '{print $4}' \
    | sed -E 's/.*:([0-9]+)$/\1/' \
    | sort -u)

  # Try the whole range in random order and avoid duplicates picked earlier in the script
  for p in $(shuf -i "$min-$max" -n "$n"); do
    if grep -qx "$p" <<<"$listening"; then continue; fi
    if [[ ${#_RESERVED_PORTS[@]} -gt 0 ]] && printf '%s\n' "${_RESERVED_PORTS[@]}" | grep -qx "$p"; then continue; fi
    _RESERVED_PORTS+=("$p")
    echo "$p"
    return 0
  done
  return 1
}

# Find a contiguous free block of ports and reserve them
find_free_port_block() {
  local min=${1:-$PREFERRED_MIN}
  local max=${2:-$PREFERRED_MAX}
  local size=${3:-200}
  local listening n cand start end port ok

  n=$(( max - min + 1 ))
  (( size >= 1 )) || { echo "[forska] bad block size: $size" >&2; return 2; }
  (( n >= size )) || { echo "[forska] bad range for size $size: $min-$max" >&2; return 2; }

  listening=$(ss -H -ltn 2>/dev/null \
    | awk '{print $4}' \
    | sed -E 's/.*:([0-9]+)$/\1/' \
    | sort -u)

  cand=$(( (max - size + 1) - min + 1 ))
  for start in $(shuf -i "$min-$((max - size + 1))" -n "$cand"); do
    end=$(( start + size - 1 ))
    ok=1
    for port in $(seq "$start" "$end"); do
      if grep -qx "$port" <<<"$listening"; then ok=0; break; fi
      if [[ ${#_RESERVED_PORTS[@]} -gt 0 ]] && printf '%s\n' "${_RESERVED_PORTS[@]}" | grep -qx "$port"; then ok=0; break; fi
    done
    if (( ok == 1 )); then
      for port in $(seq "$start" "$end"); do _RESERVED_PORTS+=("$port"); done
      echo "$start $end"
      return 0
    fi
  done
  return 1
}
# Allocate worker block FIRST (largest allocation), then individual ports OUTSIDE that block
echo "[forska] allocating ray ports from range $PREFERRED_MIN-$PREFERRED_MAX"
WORKER_PORT_BLOCK_SIZE=${WORKER_PORT_BLOCK_SIZE:-200}
if [[ -z "${RAY_WORKER_PORT_MIN:-}" || -z "${RAY_WORKER_PORT_MAX:-}" ]]; then
  echo "[forska] searching for ${WORKER_PORT_BLOCK_SIZE} contiguous free ports..."
  if read -r _WMIN _WMAX < <(find_free_port_block "$PREFERRED_MIN" "$PREFERRED_MAX" "$WORKER_PORT_BLOCK_SIZE"); then
    RAY_WORKER_PORT_MIN=${RAY_WORKER_PORT_MIN:-$_WMIN}
    RAY_WORKER_PORT_MAX=${RAY_WORKER_PORT_MAX:-$_WMAX}
    # Manually reserve the block since subshell doesn't persist _RESERVED_PORTS changes
    for p in $(seq "$RAY_WORKER_PORT_MIN" "$RAY_WORKER_PORT_MAX"); do
      _RESERVED_PORTS+=("$p")
    done
    echo "[forska] allocated worker port block: $RAY_WORKER_PORT_MIN-$RAY_WORKER_PORT_MAX (${WORKER_PORT_BLOCK_SIZE} ports, reserved in _RESERVED_PORTS)"
  else
    echo "[forska] warning: could not find ${WORKER_PORT_BLOCK_SIZE} contiguous free ports in $PREFERRED_MIN-$PREFERRED_MAX" >&2
    echo "[forska] falling back to 10100-10299" >&2
    RAY_WORKER_PORT_MIN=${RAY_WORKER_PORT_MIN:-10100}
    RAY_WORKER_PORT_MAX=${RAY_WORKER_PORT_MAX:-10299}
    # Manually reserve fallback range
    for p in $(seq "$RAY_WORKER_PORT_MIN" "$RAY_WORKER_PORT_MAX"); do
      _RESERVED_PORTS+=("$p")
    done
  fi
fi

# Now allocate individual ports OUTSIDE the worker block to avoid conflicts
echo "[forska] allocating object_manager port (avoiding ${#_RESERVED_PORTS[@]} reserved ports)..."
RAY_OBJECT_MANAGER_PORT=${RAY_OBJECT_MANAGER_PORT:-$(find_free_port || echo 10001)}
echo "[forska] allocated object_manager port: $RAY_OBJECT_MANAGER_PORT"

echo "[forska] allocating node_manager port (avoiding ${#_RESERVED_PORTS[@]} reserved ports)..."
RAY_NODE_MANAGER_PORT=${RAY_NODE_MANAGER_PORT:-$(find_free_port || echo 10002)}
echo "[forska] allocated node_manager port: $RAY_NODE_MANAGER_PORT"

echo "[forska] ray port allocation:"
echo "  - GCS port:           $RAY_PORT"
echo "  - Object manager:     $RAY_OBJECT_MANAGER_PORT"
echo "  - Node manager:       $RAY_NODE_MANAGER_PORT"
echo "  - Worker ports:       $RAY_WORKER_PORT_MIN-$RAY_WORKER_PORT_MAX"
echo "  - Dashboard:          $RAY_DASHBOARD_PORT"
echo "  - Preferred range:    $PREFERRED_MIN-$PREFERRED_MAX"

# Validate no conflicts between individual ports and worker block
for p in "$RAY_PORT" "$RAY_OBJECT_MANAGER_PORT" "$RAY_NODE_MANAGER_PORT" "$RAY_DASHBOARD_PORT"; do
  if (( p >= RAY_WORKER_PORT_MIN && p <= RAY_WORKER_PORT_MAX )); then
    echo "[forska] error: port $p conflicts with worker port range $RAY_WORKER_PORT_MIN-$RAY_WORKER_PORT_MAX" >&2
    exit 2
  fi
done
echo "[forska] port allocation validated (no conflicts detected)"

# Save detailed port allocation state for debugging
PORT_DIAG="$LOG_DIR/port-allocation.log"
cat >"$PORT_DIAG" <<PORT_DIAG_EOF
Ray Port Allocation Diagnostics
================================
Job ID: ${SLURM_JOB_ID:-manual}
Timestamp: $(date)
Host: $(hostname)

Port Assignments:
-----------------
GCS_SERVER_PORT:        $RAY_PORT
OBJECT_MANAGER_PORT:    $RAY_OBJECT_MANAGER_PORT
NODE_MANAGER_PORT:      $RAY_NODE_MANAGER_PORT
DASHBOARD_PORT:         $RAY_DASHBOARD_PORT
WORKER_PORT_MIN:        $RAY_WORKER_PORT_MIN
WORKER_PORT_MAX:        $RAY_WORKER_PORT_MAX
WORKER_PORT_COUNT:      $(( RAY_WORKER_PORT_MAX - RAY_WORKER_PORT_MIN + 1 ))

Configuration:
--------------
PREFERRED_MIN:          $PREFERRED_MIN
PREFERRED_MAX:          $PREFERRED_MAX
WORKER_BLOCK_SIZE:      $WORKER_PORT_BLOCK_SIZE

Reserved Ports Count: ${#_RESERVED_PORTS[@]}

Ports Currently Listening (pre-Ray):
--------------------------------------
$(ss -ltn | awk 'NR>1 {print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -n | uniq)
PORT_DIAG_EOF
echo "[forska] port allocation diagnostics saved to $PORT_DIAG"
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
  echo "         Set HEAD_IP=<ipv4> when submitting: sbatch --export=ALL,HEAD_IP=1.2.3.4 forska-stack.sbatch" >&2
  exit 2
fi
# Ray stores Unix domain sockets under its temp dir and Linux limits
# AF_UNIX socket paths to 107 bytes. Use a short per-job path on local tmp
# by default to avoid path length overflows on long $STACK_ROOT paths.
RAY_TMP_DIR=${RAY_TMP_DIR:-/tmp/ray-${SLURM_JOB_ID:-$$}}

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
  echo "[forska] ray tmp dir: $RAY_TMP_DIR"
  mkdir -p "$RAY_TMP_DIR"
  # Start Ray head on this node (the batch script runs on the head)
  echo "[forska] ray head ip: $HEAD_IP (port $RAY_PORT, dashboard $RAY_DASHBOARD_PORT)"
  apptainer exec --cleanenv --nv \
    --env NCCL_DEBUG="$NCCL_DEBUG" \
    --env NCCL_ASYNC_ERROR_HANDLING="$NCCL_ASYNC_ERROR_HANDLING" \
    --env CUDA_DEVICE_ORDER=PCI_BUS_ID \
    ${CUDA_VISIBLE_DEVICES:+--env CUDA_VISIBLE_DEVICES="$CUDA_VISIBLE_DEVICES"} \
    ${CUDA_VISIBLE_DEVICES:+--env NVIDIA_VISIBLE_DEVICES="$CUDA_VISIBLE_DEVICES"} \
    --env RAY_TMPDIR="$RAY_TMP_DIR" \
    ${NCCL_SOCKET_IFNAME:+--env NCCL_SOCKET_IFNAME="$NCCL_SOCKET_IFNAME"} \
    ${NCCL_IB_HCA:+--env NCCL_IB_HCA="$NCCL_IB_HCA"} \
    ${NCCL_IB_GID_INDEX:+--env NCCL_IB_GID_INDEX="$NCCL_IB_GID_INDEX"} \
    --bind "$RAY_TMP_DIR:$RAY_TMP_DIR" \
    "$SIF_VLLM" \
    ray start --head \
      --node-ip-address "$HEAD_IP" \
      --port "$RAY_PORT" \
      --object-manager-port "$RAY_OBJECT_MANAGER_PORT" \
      --node-manager-port "$RAY_NODE_MANAGER_PORT" \
      --min-worker-port "$RAY_WORKER_PORT_MIN" \
      --max-worker-port "$RAY_WORKER_PORT_MAX" \
      --dashboard-host 0.0.0.0 \
      --dashboard-port "$RAY_DASHBOARD_PORT" \
      --temp-dir "$RAY_TMP_DIR" \
      --disable-usage-stats \
    >"$LOG_DIR/ray-head.log" 2>&1 || { echo "[forska] ray head failed" >&2; exit 2; }

  # Capture actual ports Ray bound to for diagnostics
  echo "[forska] verifying ray ports..."
  RAY_PORTS_LOG="$LOG_DIR/ray-head-ports.log"
  cat >"$RAY_PORTS_LOG" <<RAY_PORTS_EOF
Ray Head Port Verification
===========================
Job ID: ${SLURM_JOB_ID:-manual}
Timestamp: $(date)

Requested Port Configuration:
------------------------------
GCS:            $RAY_PORT
Object Manager: $RAY_OBJECT_MANAGER_PORT
Node Manager:   $RAY_NODE_MANAGER_PORT
Dashboard:      $RAY_DASHBOARD_PORT
Worker Range:   $RAY_WORKER_PORT_MIN-$RAY_WORKER_PORT_MAX

Ray-specific Listening Ports:
------------------------------
RAY_PORTS_EOF
  ss -ltn | grep -E "(${RAY_PORT}|${RAY_OBJECT_MANAGER_PORT}|${RAY_NODE_MANAGER_PORT}|${RAY_DASHBOARD_PORT})" >>"$RAY_PORTS_LOG" 2>&1 || echo "(no matching ports found - possible startup failure)" >>"$RAY_PORTS_LOG"

  echo "" >>"$RAY_PORTS_LOG"
  echo "All Listening TCP Ports:" >>"$RAY_PORTS_LOG"
  echo "------------------------" >>"$RAY_PORTS_LOG"
  ss -ltn >>"$RAY_PORTS_LOG" 2>&1

  echo "[forska] ray port verification saved to $RAY_PORTS_LOG"

  # Wait for head to open core ports before launching workers
  for p in "$RAY_PORT" "$RAY_OBJECT_MANAGER_PORT" "$RAY_NODE_MANAGER_PORT"; do
    echo "[forska] waiting for head to listen on :$p"
    ok=0
    for i in $(seq 1 20); do
      if (command -v nc >/dev/null 2>&1 && timeout 2 nc -z "$HEAD_IP" "$p") || \
         timeout 2 bash -lc "echo > /dev/tcp/$HEAD_IP/$p" >/dev/null 2>&1; then
        ok=1; break
      fi
      sleep 1
    done
    if [[ $ok -ne 1 ]]; then
      echo "[forska] error: head not listening on :$p after waiting" >&2
      exit 2
    fi
  done

  # Start Ray workers on the remaining nodes
  # Prepare worker launcher script to avoid brittle quoting within srun bash -lc
  WORKER_SCRIPT="$STACK_ROOT/.cache/ray-worker-start.sh"
  mkdir -p "$(dirname "$WORKER_SCRIPT")"
  cat >"$WORKER_SCRIPT" <<'RAY_WORKER'
#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$RAY_TMP_DIR"

# Resolve IPv4 address for this worker
WORKER_IP=$(getent ahostsv4 "$(hostname -s)" | awk '{print $1; exit}' || true)
if [[ -z "${WORKER_IP:-}" ]]; then
  WORKER_IP=$(hostname -I | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$' || true)
fi
if [[ -z "${WORKER_IP:-}" ]]; then
  echo "[forska] worker: failed to resolve IPv4 address" >&2
  exit 2
fi

can_connect() {
  local host="$1" port="$2"
  if command -v nc >/dev/null 2>&1; then
    timeout 3 nc -z "$host" "$port"
  else
    (echo >/dev/tcp/"$host"/"$port") >/dev/null 2>&1
  fi
}

# Workers only need to connect to the GCS server (RAY_PORT)
# Object manager and node manager ports are per-node, not shared
ok=0
for i in $(seq 1 20); do
  if can_connect "${HEAD_IP}" "$RAY_PORT"; then ok=1; break; fi
  sleep 1
done
if [[ $ok -ne 1 ]]; then
  echo "[forska] worker: head not reachable on port $RAY_PORT" >&2
  exit 2
fi

exec apptainer exec --cleanenv --nv \
  --env NCCL_DEBUG="${NCCL_DEBUG}" \
  --env NCCL_ASYNC_ERROR_HANDLING="${NCCL_ASYNC_ERROR_HANDLING}" \
  --env CUDA_DEVICE_ORDER=PCI_BUS_ID \
  ${CUDA_VISIBLE_DEVICES:+--env CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES}"} \
  ${CUDA_VISIBLE_DEVICES:+--env NVIDIA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES}"} \
  --env RAY_TMPDIR="${RAY_TMP_DIR}" \
  ${NCCL_SOCKET_IFNAME:+--env NCCL_SOCKET_IFNAME="${NCCL_SOCKET_IFNAME}"} \
  ${NCCL_IB_HCA:+--env NCCL_IB_HCA="${NCCL_IB_HCA}"} \
  ${NCCL_IB_GID_INDEX:+--env NCCL_IB_GID_INDEX="${NCCL_IB_GID_INDEX}"} \
  --bind "${RAY_TMP_DIR}:${RAY_TMP_DIR}" \
  "${SIF_VLLM}" \
  ray start \
    --node-ip-address "${WORKER_IP}" \
    --address "${HEAD_IP}:${RAY_PORT}" \
    --min-worker-port "${RAY_WORKER_PORT_MIN}" \
    --max-worker-port "${RAY_WORKER_PORT_MAX}" \
    --disable-usage-stats
RAY_WORKER
  chmod +x "$WORKER_SCRIPT"
  # Launch Ray workers using the prepared script (robust, avoids nested quoting issues)
  if [[ ${#WORKER_NODES[@]} -gt 0 ]]; then
    srun --nodes=$((NNODES-1)) --ntasks=$((NNODES-1)) \
      --export=ALL,HEAD_IP=${HEAD_IP},RAY_PORT=${RAY_PORT},RAY_WORKER_PORT_MIN=${RAY_WORKER_PORT_MIN},RAY_WORKER_PORT_MAX=${RAY_WORKER_PORT_MAX},RAY_TMP_DIR=${RAY_TMP_DIR},SIF_VLLM=${SIF_VLLM},NCCL_DEBUG=${NCCL_DEBUG},NCCL_ASYNC_ERROR_HANDLING=${NCCL_ASYNC_ERROR_HANDLING} \
      --nodelist="$(printf "%s," "${WORKER_NODES[@]}" | sed 's/,$//')" \
      --output "$LOG_DIR/ray-worker-%N.log" \
      bash -lc "$WORKER_SCRIPT" || {
        echo "[forska] ray workers failed" >&2; exit 2;
      }
  fi
  if false && [[ ${#WORKER_NODES[@]} -gt 0 ]]; then
    srun --nodes=$((NNODES-1)) --ntasks=$((NNODES-1)) \
      --export=ALL,HEAD_IP=${HEAD_IP},RAY_PORT=${RAY_PORT},RAY_OBJECT_MANAGER_PORT=${RAY_OBJECT_MANAGER_PORT},RAY_NODE_MANAGER_PORT=${RAY_NODE_MANAGER_PORT},RAY_WORKER_PORT_MIN=${RAY_WORKER_PORT_MIN},RAY_WORKER_PORT_MAX=${RAY_WORKER_PORT_MAX} \
      --nodelist="$(printf "%s," "${WORKER_NODES[@]}" | sed 's/,$//')" \
      --output "$LOG_DIR/ray-worker-%N.log" \
      bash -lc "mkdir -p '$RAY_TMP_DIR' \
        && WORKER_IP=\$( (command -v getent >/dev/null 2>&1 && getent ahostsv4 \"\$(hostname -s)\" | awk '{print \$1; exit}') || true; \
                          [[ -n \"\$WORKER_IP\" ]] || WORKER_IP=\$(hostname -I | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\\.[0-9]+){3}$' || true); \
                          echo -n \"\$WORKER_IP\" ) \
        && { [[ -n \"\$WORKER_IP\" ]] || { echo '[forska] worker: failed to resolve IPv4 address' >&2; exit 2; }; } \
        && ok=0; for i in $(seq 1 20); do { (command -v nc >/dev/null 2>&1 && timeout 3 nc -z \"\${HEAD_IP}\" \"\${RAY_PORT}\") || timeout 3 bash -lc 'echo > /dev/tcp/'\"\${HEAD_IP}\"'/'\"\${RAY_PORT}\" >/dev/null 2>&1; } && ok=1 && break; sleep 1; done; [[ $ok -eq 1 ]] \
        && ok=0; for i in $(seq 1 20); do { (command -v nc >/dev/null 2>&1 && timeout 3 nc -z \"\${HEAD_IP}\" \"$RAY_OBJECT_MANAGER_PORT\") || timeout 3 bash -lc 'echo > /dev/tcp/'\"\${HEAD_IP}\"'/'\"$RAY_OBJECT_MANAGER_PORT\" >/dev/null 2>&1; } && ok=1 && break; sleep 1; done; [[ $ok -eq 1 ]] \
        && ok=0; for i in $(seq 1 20); do { (command -v nc >/dev/null 2>&1 && timeout 3 nc -z \"\${HEAD_IP}\" \"$RAY_NODE_MANAGER_PORT\") || timeout 3 bash -lc 'echo > /dev/tcp/'\"\${HEAD_IP}\"'/'\"$RAY_NODE_MANAGER_PORT\" >/dev/null 2>&1; } && ok=1 && break; sleep 1; done; [[ $ok -eq 1 ]] \
        && apptainer exec --cleanenv --nv \
             --env NCCL_DEBUG='$NCCL_DEBUG' \
             --env NCCL_ASYNC_ERROR_HANDLING='$NCCL_ASYNC_ERROR_HANDLING' \
             --env CUDA_DEVICE_ORDER=PCI_BUS_ID \
             ${CUDA_VISIBLE_DEVICES:+--env CUDA_VISIBLE_DEVICES="$CUDA_VISIBLE_DEVICES"} \
             ${CUDA_VISIBLE_DEVICES:+--env NVIDIA_VISIBLE_DEVICES="$CUDA_VISIBLE_DEVICES"} \
             --env RAY_TMPDIR="$RAY_TMP_DIR" \
             ${NCCL_SOCKET_IFNAME:+--env NCCL_SOCKET_IFNAME='$NCCL_SOCKET_IFNAME'} \
             ${NCCL_IB_HCA:+--env NCCL_IB_HCA='$NCCL_IB_HCA'} \
             ${NCCL_IB_GID_INDEX:+--env NCCL_IB_GID_INDEX='$NCCL_IB_GID_INDEX'} \
             '$SIF_VLLM' \
             ray start \
               --node-ip-address \"\$WORKER_IP\" \
               --address \"\${HEAD_IP}:\${RAY_PORT}\" \
               --object-manager-port \"$RAY_OBJECT_MANAGER_PORT\" \
               --node-manager-port \"$RAY_NODE_MANAGER_PORT\" \
               --min-worker-port \"$RAY_WORKER_PORT_MIN\" \
               --max-worker-port \"$RAY_WORKER_PORT_MAX\" \
               --disable-usage-stats" || {
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
  VLLM_ENV+=(--env RAY_ADDRESS="${HEAD_IP}:${RAY_PORT}")
  VLLM_ENV+=(--env RAY_TMPDIR="$RAY_TMP_DIR")
fi

apptainer run --cleanenv --nv \
  "${VLLM_ENV[@]}" \
  --env CUDA_DEVICE_ORDER=PCI_BUS_ID \
  ${CUDA_VISIBLE_DEVICES:+--env CUDA_VISIBLE_DEVICES="$CUDA_VISIBLE_DEVICES"} \
  ${CUDA_VISIBLE_DEVICES:+--env NVIDIA_VISIBLE_DEVICES="$CUDA_VISIBLE_DEVICES"} \
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
  echo "  ray head:    ${HEAD_IP}:${RAY_PORT} (dashboard :${RAY_DASHBOARD_PORT})"
  echo "  nodes:       ${HOSTS[*]}"
fi
echo "  dist:        ${NNODES} node(s) × ${GPUS_PER_NODE} GPU(s) = ${TOTAL_GPUS} (tp=${TP_SIZE}, dp=${DP_SIZE})"
echo "  api:         http://127.0.0.1:$API_SERVER_PORT"
echo "  app:         http://127.0.0.1:$PROD_SERVER"
echo "[forska] tail logs in: $LOG_DIR"
echo "[forska] for ssh tunnel to the api"
echo "  ssh -N -L 3001:$(hostname):$API_SERVER_PORT alvis2"
echo "[forska] for ssh tunnel to the vllm server"
echo "  ssh -N -L 8000:$(hostname):8000 alvis2"

# Block until all background services exit
wait
