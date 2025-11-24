#!/bin/bash
#SBATCH --account=ehpc-aif-2025pg01-233
#SBATCH --qos=ehpc-aif-2025pg01-233
#SBATCH -p common
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=2
#SBATCH --ntasks-per-core=1
#SBATCH --cpus-per-task=28
#SBATCH --gres=gpu:1
#SBATCH --time=17:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

set -euo pipefail

ENTITY="works"

echo "[openalex-pg] [flatten-${ENTITY}] starting on host $(hostname) at $(date)"

export STACK_ROOT=${STACK_ROOT:-/valhalla/projects/ehpc-aif-2025pg01-233/dev}
mkdir -p "$STACK_ROOT"/{pgdata,logs,.secrets,openalex-snapshot,csv-files}

LOG_DIR="$STACK_ROOT/logs/openalex-pg-${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

echo "[openalex-pg] [flatten-${ENTITY}] checking host python"
if ! command -v python >/dev/null 2>&1; then
  echo "[openalex-pg] [flatten-${ENTITY}] python not found on host; aborting" >&2
  exit 2
fi
echo "[openalex-pg] [flatten-${ENTITY}] python version: $(python --version 2>&1)"

FLATTEN_SCRIPT="$STACK_ROOT/flatten-openalex-jsonl.py"
if [ ! -f "$FLATTEN_SCRIPT" ]; then
  echo "[openalex-pg] [flatten-${ENTITY}] missing flatten script at $FLATTEN_SCRIPT; aborting" >&2
  exit 2
fi

cd "$STACK_ROOT"
set +e
python "flatten-openalex-jsonl.py" "${ENTITY}" >>"$LOG_DIR/flatten-${ENTITY}.log" 2>&1
EXIT_CODE=$?
set -e

echo "[openalex-pg] [flatten-${ENTITY}] exit code: $EXIT_CODE"
exit "$EXIT_CODE"
