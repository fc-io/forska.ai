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

# Generate a container-side import script that loads all snapshot JSON
IMPORT_SH_HOST="$STACK_ROOT/openalex-snapshot/openalex_import.sh"

cat >"$IMPORT_SH_HOST" <<'EOSH'
#!/usr/bin/env bash
set -euo pipefail

echo "[openalex-pg] [import] starting import script inside container"

if [ ! -f /run/secrets/db_password ]; then
  echo "[openalex-pg] [import] missing /run/secrets/db_password inside container" >&2
  exit 2
fi

export PGPASSWORD="$(cat /run/secrets/db_password)"
psql_base="psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres"

echo "[openalex-pg] [import] ensuring database openalex_snapshot exists"
if ! $psql_base -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'openalex_snapshot'" | grep -q 1; then
  echo "[openalex-pg] [import] creating database openalex_snapshot"
  $psql_base -d postgres -c "CREATE DATABASE openalex_snapshot;"
else
  echo "[openalex-pg] [import] database openalex_snapshot already exists"
fi

echo "[openalex-pg] [import] ensuring schema and raw_json_lines table exist"
$psql_base -d openalex_snapshot <<'EOSQL'
CREATE SCHEMA IF NOT EXISTS openalex;
CREATE TABLE IF NOT EXISTS openalex.raw_json_lines (
  entity text NOT NULL,
  source text NOT NULL,
  line   text NOT NULL
);
EOSQL

root="/data/openalex"

import_root() {
  local base="$1"
  local label="$2"

  if [ ! -d "$base" ]; then
    echo "[openalex-pg] [import] no directory found at $base; skipping $label"
    return 0
  fi

  echo "[openalex-pg] [import] scanning $base for .gz files ($label)"
  local count=0

  while IFS= read -r -d '' gz; do
    count=$((count + 1))
    rel="${gz#$root/}"        # e.g. data/works/..., legacy-data/works/...

    case "$rel" in
      data/*)
        entity="$(printf '%s' "$rel" | cut -d/ -f2)"
        ;;
      legacy-data/*)
        entity="$(printf '%s' "$rel" | cut -d/ -f2)"
        ;;
      *)
        entity="unknown"
        ;;
    esac

    echo "[openalex-pg] [import] [$label] loading file: $rel (entity=${entity})"

    # Remove any previous rows for this file to make the import idempotent
    $psql_base -d openalex_snapshot <<EOSQL2
DELETE FROM openalex.raw_json_lines
WHERE source = '$(printf "%s" "$rel" | sed "s/'/''/g")';
EOSQL2

    # Stream JSON lines into COPY, prefixing entity and source as tab-separated fields
    if ! gzip -dc "$gz" 2>/dev/null | sed "s/^/${entity}\t${rel}\t/" | \
      $psql_base -d openalex_snapshot -c "COPY openalex.raw_json_lines (entity, source, line) FROM STDIN WITH (FORMAT text)"; then
      echo "[openalex-pg] [import] ERROR while loading $rel; aborting import" >&2
      exit 1
    fi

    echo "[openalex-pg] [import] [$label] finished file: $rel"
  done < <(find "$base" -type f -name '*.gz' -print0)

  if [ "$count" -eq 0 ]; then
    echo "[openalex-pg] [import] no .gz files found under $base; skipping $label"
  else
    echo "[openalex-pg] [import] processed $count file(s) under $base ($label)"
  fi
}

import_root "$root/data" "current"
import_root "$root/legacy-data" "legacy"

echo "[openalex-pg] [import] completed import from $root"
EOSH

chmod +x "$IMPORT_SH_HOST"

echo "[openalex-pg] invoking import script inside container"
apptainer exec --cleanenv \
  --bind "$STACK_ROOT/openalex-snapshot:/data/openalex:ro" \
  --bind "$DB_PW_FILE:/run/secrets/db_password:ro" \
  "$SIF_DB" /data/openalex/openalex_import.sh \
  >>"$LOG_DIR/db.log" 2>&1

echo "[openalex-pg] import script finished; stopping postgres"
kill -TERM "$DB_PID" 2>/dev/null || true
wait "$DB_PID" || true
