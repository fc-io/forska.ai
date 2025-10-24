# Slurm sbatch example (Apptainer)

Single sbatch script to run the database (Postgres), the API + app servers, and the GPU-backed vLLM service together on one Slurm node using Apptainer. It follows the host-network Apptainer guidance from README.md so all services listen on localhost.

Read first (from README.md)
- Set `STACK_ROOT` and create shared dirs: `pgdata`, `models`, `hf_cache`, `logs`, `.cache`.
- Pre-pull SIFs into `$STACK_ROOT`: `postgres_18.sif`, `vllm_openai_latest.sif`, `api_server.sif`, `app_server.sif`.
- Create secrets under `$STACK_ROOT/.secrets`: `db_password.txt` and `database_url.txt`. Optional: `better_auth_secret.txt`, `better_auth_url.txt`.
- Ensure env has `VLLM_API_KEY` (temporary; see README.md).

 Assumptions
- Apptainer is available on the compute node (e.g., `module load apptainer`).
- Ports 5432 (db), 8000 (vLLM), 3001 (API), and 8181 (app) are free on the node and reachable via SSH port-forwarding.

Submit with `sbatch forska-stack.sbatch` (if your cluster does not export environment variables to jobs by default, use `sbatch --export=ALL forska-stack.sbatch` or keep the directive in the script below), then tunnel from your laptop:

```
# After the job starts, check the compute hostname printed in the logs, e.g. c17-42
ssh -N \
  -L 8181:c17-42:8181 \
  -L 3001:c17-42:3001 \
  -L 8000:c17-42:8000 \
  your-user@cluster-login
```

Open the app at http://localhost:8181 (it proxies API calls to http://localhost:3001). vLLM is exposed at http://localhost:8000/v1.

forska-stack.sbatch
```
#!/bin/bash
#SBATCH -J forska-stack
#SBATCH -p <your_gpu_partition>
#SBATCH -A <your_account>
#SBATCH --gres=gpu:1
#SBATCH --time=08:00:00
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH -o %x-%j.out
#SBATCH -e %x-%j.err
#SBATCH --export=ALL

set -euo pipefail

echo "[forska] starting on host $(hostname) at $(date)"

# Optional, if your cluster uses environment modules
# module purge
# module load apptainer

# Shared root and caches (see README.md)
export STACK_ROOT=${STACK_ROOT:-$PWD}
mkdir -p "$STACK_ROOT"/{pgdata,models,hf_cache,logs,.cache}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$STACK_ROOT/.cache}
export VLLM_CACHE_ROOT=${VLLM_CACHE_ROOT:-$XDG_CACHE_HOME/vllm}
export TORCHINDUCTOR_CACHE_DIR=${TORCHINDUCTOR_CACHE_DIR:-$VLLM_CACHE_ROOT/torchinductor}
export TRITON_CACHE_DIR=${TRITON_CACHE_DIR:-$VLLM_CACHE_ROOT/triton}
export HF_HOME=${HF_HOME:-$STACK_ROOT/hf_cache}

# Service ports (host networking)
export POSTGRES_PORT=${POSTGRES_PORT:-5432}
export API_SERVER_PORT=${API_SERVER_PORT:-3001}
export PROD_SERVER=${PROD_SERVER:-8181}

# vLLM runtime knobs
export VLLM_API_KEY=${VLLM_API_KEY:?set VLLM_API_KEY in your env}
export VLLM_GPU_UTIL=${VLLM_GPU_UTIL:-0.90}
export TP_SIZE=${TP_SIZE:-1}

# Client/API URLs used by the compiled servers
export VITE_LLM_SERVER_URL=${VITE_LLM_SERVER_URL:-http://localhost:8000/v1}
export VITE_SERVER_API=${VITE_SERVER_API:-http://localhost:${API_SERVER_PORT}}
export VITE_PORT=${VITE_PORT:-8181}

SIF_DB="$STACK_ROOT/postgres_18.sif"
SIF_VLLM="$STACK_ROOT/vllm_openai_latest.sif"
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

cleanup() {
  echo "[forska] cleaning up..."
  jobs -pr | xargs -r kill || true
}
trap cleanup EXIT INT TERM

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

echo "[forska] starting vllm on :8000"
apptainer run --cleanenv --nv \
  --bind "$STACK_ROOT/models:/models:ro" \
  "$SIF_VLLM" \
  vllm serve /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --tensor-parallel-size "$TP_SIZE" \
    --gpu-memory-utilization "$VLLM_GPU_UTIL" \
    --api-key "$VLLM_API_KEY" \
  >"$LOG_DIR/vllm.log" 2>&1 &

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
echo "  api:         http://127.0.0.1:$API_SERVER_PORT"
echo "  app:         http://127.0.0.1:$PROD_SERVER"
echo "[forska] tail logs in: $LOG_DIR"

# Block until all background services exit
wait
```

Notes
- The script keeps all services in a single job on one node, using host networking so `localhost` is shared across containers.
- The API reads secrets via `*_FILE` env fallbacks. If Better Auth files are absent, those envs are ignored.
- vLLM requires a GPU. Increase `--gres=gpu:<N>` and set `TP_SIZE=<N>` if serving with tensor parallelism.
- Update partition/account/directives to match your cluster.

Quick checks
- Compute node and job: printed at start; also see `squeue -j <jobid>`.
- Health: check logs in `$STACK_ROOT/logs/<jobid>/`.
- vLLM: `curl -sf -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models | jq .` (from the compute node or via tunnel).
