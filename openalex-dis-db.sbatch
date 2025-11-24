#!/bin/bash
#SBATCH --account=ehpc-aif-2025pg01-233
#SBATCH --qos=ehpc-aif-2025pg01-233
#SBATCH -p common
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=2
#SBATCH --ntasks-per-core=1
#SBATCH --cpus-per-task=28
#SBATCH --gres=gpu:2
#SBATCH --time=08:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

set -euo pipefail

echo "[openalex-pg] starting on host $(hostname) at $(date)"

# Shared root and secrets (DIS)
export STACK_ROOT=${STACK_ROOT:-/valhalla/projects/ehpc-aif-2025pg01-233/dev}
mkdir -p "$STACK_ROOT"/{pgdata,logs,.secrets,openalex-snapshot}

# Postgres port (can be overridden when submitting)
export POSTGRES_PORT=${POSTGRES_PORT:-5432}

SIF_DB="$STACK_ROOT/postgres_18.sif"
DB_PW_FILE="$STACK_ROOT/.secrets/db_password.txt"
export SIF_DB DB_PW_FILE

need() {
  if [ ! -f "$1" ]; then
    echo "[openalex-pg] missing: $1" >&2
    exit 2
  fi
}

need "$SIF_DB"
need "$DB_PW_FILE"

LOG_DIR="$STACK_ROOT/logs/openalex-pg-${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

# Flatten JSONL to CSV using the official OpenAlex script on the host
echo "[openalex-pg] [flatten] checking host python"
if ! command -v python >/dev/null 2>&1; then
  echo "[openalex-pg] [flatten] python not found on host; aborting" >&2
  exit 2
fi
echo "[openalex-pg] [flatten] python version: $(python --version 2>&1)"

FLATTEN_SCRIPT="$STACK_ROOT/flatten-openalex-jsonl.py"
if [ ! -f "$FLATTEN_SCRIPT" ]; then
  echo "[openalex-pg] [flatten] missing flatten script at $FLATTEN_SCRIPT; aborting" >&2
  exit 2
fi

echo "[openalex-pg] [flatten] running flatten-openalex-jsonl.py (this may take hours)"
cd "$STACK_ROOT"
mkdir -p csv-files

set +e
# Run each entity in parallel (separate processes, separate logs)
declare -A PIDS
declare -A EXITS
ENTITIES=(topics authors concepts institutions publishers sources works)

for ent in "${ENTITIES[@]}"; do
  echo "[openalex-pg] [flatten] starting ${ent}"
  python "flatten-openalex-jsonl.py" "${ent}" >>"$LOG_DIR/flatten-${ent}.log" 2>&1 &
  PIDS["$ent"]=$!
done

for ent in "${ENTITIES[@]}"; do
  wait "${PIDS[$ent]}"
  EXITS["$ent"]=$?
  echo "[openalex-pg] [flatten] ${ent} exit code: ${EXITS[$ent]}"
done
set -e

FAILED=0
for ent in "${ENTITIES[@]}"; do
  if [ "${EXITS[$ent]}" -ne 0 ]; then
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "[openalex-pg] [flatten] one or more entities failed; see per-entity logs in $LOG_DIR/flatten-*.log" >&2
  exit 2
fi

echo "[openalex-pg] [flatten] flatten script completed; CSV files should be under $STACK_ROOT/csv-files"
cd - >/dev/null 2>&1 || true

postgres_ping() {
  if apptainer exec --cleanenv "$SIF_DB" pg_isready \
    -h 127.0.0.1 \
    -p "$POSTGRES_PORT" \
    -d "${DB_NAME:-postgres}" \
    -U "${DB_USER:-postgres}" >/dev/null 2>&1; then
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
      echo "[openalex-pg] postgres is accepting connections"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[openalex-pg] postgres process ($pid) exited early; see $log" >&2
      return 1
    fi
    sleep "$delay"
  done

  echo "[openalex-pg] postgres failed to become ready within ${elapsed}s; see $log" >&2
  return 1
}

graceful_shutdown() {
  echo "[openalex-pg] shutting down..."
  if [[ -n "${DB_PID:-}" ]] && kill -0 "$DB_PID" 2>/dev/null; then
    kill -TERM "$DB_PID" 2>/dev/null || true
    for ((i=0; i<10; i++)); do
      kill -0 "$DB_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$DB_PID" 2>/dev/null; then
      kill -KILL "$DB_PID" 2>/dev/null || true
    fi
  fi
}

trap 'graceful_shutdown' EXIT
trap 'graceful_shutdown' INT TERM USR1

echo "[openalex-pg] starting postgres on :$POSTGRES_PORT"
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
  echo "[openalex-pg] postgres failed to accept connections; aborting" >&2
  exit 2
fi

echo "[openalex-pg] postgres is running"
echo "  host: $(hostname)"
echo "  port: $POSTGRES_PORT"
echo "  logs: $LOG_DIR/db.log"

# Ensure openalex_snapshot database exists
echo "[openalex-pg] ensuring database openalex_snapshot exists"
set +e
apptainer exec --cleanenv \
  --bind "$DB_PW_FILE:/run/secrets/db_password:ro" \
  "$SIF_DB" bash <<'EOSQL' >>"$LOG_DIR/db.log" 2>&1
set -euo pipefail
export PGPASSWORD="$(cat /run/secrets/db_password)"
psql_base="psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres"
if ! $psql_base -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'openalex_snapshot'" | grep -q 1; then
  echo "[openalex-pg] [schema] creating database openalex_snapshot"
  $psql_base -d postgres -c "CREATE DATABASE openalex_snapshot;"
else
  echo "[openalex-pg] [schema] database openalex_snapshot already exists"
fi
EOSQL
DB_CREATE_EXIT=$?
set -e
if [ "$DB_CREATE_EXIT" -ne 0 ]; then
  echo "[openalex-pg] failed to ensure openalex_snapshot exists; see $LOG_DIR/db.log" >&2
  kill -TERM "$DB_PID" 2>/dev/null || true
  wait "$DB_PID" || true
  exit 2
fi

# Apply OpenAlex schema if available
SCHEMA_SQL_HOST="$STACK_ROOT/openalex-pg-schema.sql"
if [ -f "$SCHEMA_SQL_HOST" ]; then
  echo "[openalex-pg] applying schema from $SCHEMA_SQL_HOST"
  set +e
  apptainer exec --cleanenv \
    --bind "$STACK_ROOT:/stack" \
    --bind "$DB_PW_FILE:/run/secrets/db_password:ro" \
    "$SIF_DB" bash <<'EOSCHEMA' >>"$LOG_DIR/db.log" 2>&1
set -euo pipefail
export PGPASSWORD="$(cat /run/secrets/db_password)"
cd /stack
psql -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p 5432 \
  -U postgres \
  -d openalex_snapshot \
  -f openalex-pg-schema.sql
EOSCHEMA
  SCHEMA_EXIT=$?
  set -e
  echo "[openalex-pg] schema script exited with code $SCHEMA_EXIT"
  if [ "$SCHEMA_EXIT" -ne 0 ]; then
    echo "[openalex-pg] schema application failed; see $LOG_DIR/db.log" >&2
    kill -TERM "$DB_PID" 2>/dev/null || true
    wait "$DB_PID" || true
    exit 2
  fi
else
  echo "[openalex-pg] no schema file found at $SCHEMA_SQL_HOST; skipping schema application"
fi

# Load CSV data using copy-openalex-csv.sql if available
COPY_SQL_HOST="$STACK_ROOT/copy-openalex-csv.sql"
if [ -f "$COPY_SQL_HOST" ]; then
  echo "[openalex-pg] loading CSV data using $COPY_SQL_HOST"
  set +e
  apptainer exec --cleanenv \
    --bind "$STACK_ROOT:/stack" \
    --bind "$DB_PW_FILE:/run/secrets/db_password:ro" \
    "$SIF_DB" bash <<'EOCOPY' >>"$LOG_DIR/db.log" 2>&1
set -euo pipefail
export PGPASSWORD="$(cat /run/secrets/db_password)"
cd /stack
psql -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p 5432 \
  -U postgres \
  -d openalex_snapshot \
  -f copy-openalex-csv.sql
EOCOPY
  COPY_EXIT=$?
  set -e
  echo "[openalex-pg] copy script exited with code $COPY_EXIT"
  if [ "$COPY_EXIT" -ne 0 ]; then
    echo "[openalex-pg] copy script failed; see $LOG_DIR/db.log" >&2
    kill -TERM "$DB_PID" 2>/dev/null || true
    wait "$DB_PID" || true
    exit 2
  fi
else
  echo "[openalex-pg] no copy script found at $COPY_SQL_HOST; skipping CSV load"
fi

echo "[openalex-pg] stopping postgres"
kill -TERM "$DB_PID" 2>/dev/null || true
wait "$DB_PID" || true
