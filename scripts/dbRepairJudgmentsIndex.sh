#!/usr/bin/env bash
set -euo pipefail

# Repair the corrupted B-tree primary key index on table `judgments`.
# Default target is a remote DB tunneled to localhost:8432.

usage() {
  cat <<'USAGE'
Repair the primary key index for table `judgments` using local psql.

Environment variables (with defaults):
  DB_HOST         Hostname (default: 127.0.0.1)
  DB_PORT         Port (default: 8432)
  DB_USER         User (default: postgres)
  DB_NAME         Database name (default: postgres)
  DB_SCHEMA       Schema name (default: public)
  DB_PASS         Password (optional; if set, used via PGPASSWORD)

Flags:
  -h, --host      Override DB_HOST
  -p, --port      Override DB_PORT
  -U, --user      Override DB_USER
  -d, --dbname    Override DB_NAME
  -s, --schema    Override DB_SCHEMA
  -y, --yes       Do not prompt, attempt repair immediately
  -n, --no-concurrent  If set, fall back to non-concurrent REINDEX immediately (locks table)
  --help          Show this help

Examples (with SSH tunnel on localhost:8432):
  DB_PASS=secret ./scripts/dbRepairJudgmentsIndex.sh
  ./scripts/dbRepairJudgmentsIndex.sh -p 8432 -U postgres -d postgres

USAGE
}

DB_HOST=${DB_HOST:-127.0.0.1}
DB_PORT=${DB_PORT:-8432}
DB_USER=${DB_USER:-postgres}
DB_NAME=${DB_NAME:-postgres}
DB_SCHEMA=${DB_SCHEMA:-public}
ASSUME_YES=false
NO_CONCURRENT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--host) DB_HOST="$2"; shift 2 ;;
    -p|--port) DB_PORT="$2"; shift 2 ;;
    -U|--user) DB_USER="$2"; shift 2 ;;
    -d|--dbname) DB_NAME="$2"; shift 2 ;;
    -s|--schema) DB_SCHEMA="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    -n|--no-concurrent) NO_CONCURRENT=true; shift ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if ! command -v psql >/dev/null 2>&1; then
  echo "[db-repair] psql is not installed / not on PATH" >&2
  exit 127
fi

PSQL=(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

if [[ -n "${DB_PASS:-}" ]]; then
  export PGPASSWORD="$DB_PASS"
fi

echo "[db-repair] Target: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} schema=${DB_SCHEMA}"
echo "[db-repair] Will repair index: ${DB_SCHEMA}.judgments_pkey"

if [[ "$ASSUME_YES" != true ]]; then
  read -r -p "Proceed with REINDEX on ${DB_SCHEMA}.judgments_pkey? [y/N] " ans
  case "${ans:-}" in
    y|Y|yes|YES) : ;; 
    *) echo "[db-repair] Aborted by user"; exit 1 ;;
  esac
fi

if [[ "$NO_CONCURRENT" = true ]]; then
  echo "[db-repair] Running non-concurrent REINDEX INDEX (will lock the index/table briefly)"
  if "${PSQL[@]}" -c "REINDEX INDEX ${DB_SCHEMA}.judgments_pkey;"; then
    echo "[db-repair] Success: non-concurrent REINDEX completed"
    exit 0
  fi
  echo "[db-repair] Failure: non-concurrent REINDEX failed" >&2
  exit 1
fi

echo "[db-repair] Attempt 1: REINDEX INDEX CONCURRENTLY ${DB_SCHEMA}.judgments_pkey;"
if "${PSQL[@]}" -c "REINDEX INDEX CONCURRENTLY ${DB_SCHEMA}.judgments_pkey;"; then
  echo "[db-repair] Success: index rebuilt concurrently"
  exit 0
fi

echo "[db-repair] Attempt 1 failed. Trying table-level concurrent reindex..."
if "${PSQL[@]}" -c "REINDEX TABLE CONCURRENTLY ${DB_SCHEMA}.judgments;"; then
  echo "[db-repair] Success: table reindexed concurrently"
  exit 0
fi

echo "[db-repair] Both concurrent attempts failed."
echo "[db-repair] You can try a blocking reindex during a quiet window:"
echo "           PGPASSWORD=... psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c 'REINDEX INDEX ${DB_SCHEMA}.judgments_pkey;'"
echo "[db-repair] Or force now with: ./scripts/dbRepairJudgmentsIndex.sh --yes --no-concurrent"
exit 1
