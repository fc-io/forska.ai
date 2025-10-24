# Slurm sbatch examples (Apptainer)

These examples show how to run the database (Postgres), the GPU-backed vLLM server, and the web app using Apptainer on an HPC cluster managed by Slurm.

Before using these, follow the Host networking – for HPCs running Apptainer section in README.md to:
- Set `STACK_ROOT` and create the shared dirs (`pgdata`, `models`, `hf_cache`, `logs`, `.cache`).
- Pull the required SIF images into `$STACK_ROOT`.
- Create secrets under `$STACK_ROOT/.secrets` as described (database password and connection URL).

Assumptions
- Apptainer is available on the compute node (adjust the optional `module load` lines if your cluster uses modules).
- The following SIFs exist in `$STACK_ROOT`: `postgres_18.sif`, `vllm_openai_latest.sif`, `app_server.sif`.
- Ports 5432 (db), 8000 (vLLM), and 8123 (app) are reachable from where you access them (often via SSH tunnel).

Tip: Submit with your environment exported to the job (so `STACK_ROOT`, `VLLM_API_KEY`, etc. are inherited):

```
export STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev
export VLLM_API_KEY=replace-me
sbatch --export=ALL db.sbatch
sbatch --export=ALL vllm.sbatch
sbatch --export=ALL app.sbatch
```

## db.sbatch — Postgres 18 over TCP

```
#!/bin/bash
#SBATCH --job-name=pg18
#SBATCH --time=7-00:00:00
#SBATCH --cpus-per-task=1
#SBATCH --mem=2G
#SBATCH --output=%x-%j.out
#SBATCH --export=ALL

set -euo pipefail

# Optional, adapt to your cluster
module load apptainer 2>/dev/null || true

: "${STACK_ROOT:?Set STACK_ROOT to your shared path}"
mkdir -p "$STACK_ROOT/logs"

echo "[pg18] starting at $(date)"
echo "[pg18] STACK_ROOT=$STACK_ROOT"

exec apptainer run --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=${DB_NAME:-postgres} \
  --bind ${STACK_ROOT}/pgdata:/var/lib/postgresql \
  --bind ${STACK_ROOT}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  ${STACK_ROOT}/postgres_18.sif
```

Notes
- The database listens on `localhost:5432` on the compute node. Tunnel to it as needed.
- The data directory persists under `$STACK_ROOT/pgdata`.

## vllm.sbatch — vLLM OpenAI-compatible server (GPU)

```
#!/bin/bash
#SBATCH --job-name=vllm
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1
#SBATCH --time=12:00:00
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --output=%x-%j.out
#SBATCH --export=ALL

set -euo pipefail
module load apptainer 2>/dev/null || true

: "${STACK_ROOT:?Set STACK_ROOT to your shared path}"
: "${VLLM_API_KEY:?Export VLLM_API_KEY before submitting}"

# Recommended caches (from README)
export XDG_CACHE_HOME=${STACK_ROOT}/.cache
export VLLM_CACHE_ROOT=${XDG_CACHE_HOME}/vllm
export TORCHINDUCTOR_CACHE_DIR=${VLLM_CACHE_ROOT}/torchinductor
export TRITON_CACHE_DIR=${VLLM_CACHE_ROOT}/triton
export HF_HOME=${STACK_ROOT}/hf_cache

mkdir -p "$STACK_ROOT/logs"
echo "[vllm] starting at $(date)"
echo "[vllm] STACK_ROOT=$STACK_ROOT"

exec apptainer run --cleanenv --nv \
  --bind ${STACK_ROOT}/models:/models:ro \
  ${STACK_ROOT}/vllm_openai_latest.sif \
  vllm serve /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --api-key "$VLLM_API_KEY"
```

Notes
- Adjust partition/constraints to your cluster. For multiple GPUs, update `--gres` and add model args as needed.
- Ensure the model directory exists at `$STACK_ROOT/models/Qwen3-32B-FP8` (or change the path in the command).

## app.sbatch — Solid app server (talks to API over HTTP)

```
#!/bin/bash
#SBATCH --job-name=app
#SBATCH --time=3-00:00:00
#SBATCH --cpus-per-task=2
#SBATCH --mem=2G
#SBATCH --output=%x-%j.out
#SBATCH --export=ALL

set -euo pipefail
module load apptainer 2>/dev/null || true

: "${STACK_ROOT:?Set STACK_ROOT to your shared path}"
mkdir -p "$STACK_ROOT/logs"

echo "[app] starting at $(date)"
echo "[app] STACK_ROOT=$STACK_ROOT"

# The app expects the API to be reachable on http://localhost:3001
# Make sure the API container is running on the same node, or change API_SERVER_PORT accordingly.
exec apptainer run --cleanenv \
  --env SERVER_HOST=localhost \
  --env API_SERVER_PORT=3001 \
  --env PROD_SERVER=8123 \
  "${STACK_ROOT}/app_server.sif"
```

Notes
- The app serves HTTP on port `8123` by default (as per README). Change `PROD_SERVER` to expose a different port.
- Ensure the API server is running (see README for the API `apptainer run` command). If you prefer, create a similar `api.sbatch` using the API snippet from the README.

## Monitoring and access
- Check jobs: `squeue -u "$USER"`
- Tail logs: `tail -f app-<jobid>.out`, `tail -f vllm-<jobid>.out`, or use `%x-%j.out` paths from your submit directory.
- Port-forward (example): `ssh -NL 8123:localhost:8123 your-user@hpc-login` to access the app from your laptop.

