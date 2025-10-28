#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf "[%s] %s\n" "$(date +'%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# Required env with sane defaults
BUCARDO_DB_HOST=${BUCARDO_DB_HOST:-db}
BUCARDO_DB_PORT=${BUCARDO_DB_PORT:-5432}
BUCARDO_DB_NAME=${BUCARDO_DB_NAME:-bucardo}
BUCARDO_DB_USER=${BUCARDO_DB_USER:-postgres}
BUCARDO_DB_PASS=${BUCARDO_DB_PASS:-postgres}

LOCAL_PG_HOST=${LOCAL_PG_HOST:-db}
LOCAL_PG_PORT=${LOCAL_PG_PORT:-5432}
LOCAL_PG_DB=${LOCAL_PG_DB:-postgres}
LOCAL_PG_USER=${LOCAL_PG_USER:-postgres}
LOCAL_PG_PASS=${LOCAL_PG_PASS:-postgres}

REMOTE_PG_HOST=${REMOTE_PG_HOST:-host.docker.internal}
REMOTE_PG_PORT=${REMOTE_PG_PORT:-8432}
REMOTE_PG_DB=${REMOTE_PG_DB:-postgres}
REMOTE_PG_USER=${REMOTE_PG_USER:-postgres}
REMOTE_PG_PASS=${REMOTE_PG_PASS:-postgres}

SYNC_SCHEMAS=${SYNC_SCHEMAS:-public}
EXCLUDE_TABLES=${EXCLUDE_TABLES:-drizzle.__drizzle_migrations}
RELGROUP=${RELGROUP:-public_all}
SYNC_NAME=${SYNC_NAME:-public_all_sync}
CONFLICT_STRATEGY=${CONFLICT_STRATEGY:-latest}
CONFLICT_COLUMN=${CONFLICT_COLUMN:-updated_at}

export PGPASSWORD="$LOCAL_PG_PASS"

wait_for_pg() {
  local host="$1"; local port="$2"; local user="$3"; local dbname="$4"
  log "Waiting for Postgres ${host}:${port}/${dbname}..."
  for i in {1..60}; do
    if command -v pg_isready >/dev/null 2>&1; then
      if pg_isready -h "$host" -p "$port" -U "$user" >/dev/null 2>&1; then
        log "Postgres at ${host}:${port} is ready."
        return 0
      fi
    else
      if PGPASSWORD="$LOCAL_PG_PASS" psql -h "$host" -p "$port" -U "$user" -d "$dbname" -At -c 'SELECT 1' >/dev/null 2>&1; then
        log "Postgres at ${host}:${port} is ready."
        return 0
      fi
    fi
    sleep 2
  done
  log "ERROR: Timed out waiting for Postgres ${host}:${port}/${dbname}"
  return 1
}

# 1) Wait for local DB (used for both data and Bucardo control database)
wait_for_pg "$LOCAL_PG_HOST" "$LOCAL_PG_PORT" "$LOCAL_PG_USER" "$LOCAL_PG_DB"

# 2) Ensure Bucardo control database exists on local cluster
if ! psql -h "$LOCAL_PG_HOST" -p "$LOCAL_PG_PORT" -U "$LOCAL_PG_USER" -tAc "SELECT 1 FROM pg_database WHERE datname='${BUCARDO_DB_NAME}'" | grep -q 1; then
  log "Creating Bucardo control database '${BUCARDO_DB_NAME}'"
  psql -h "$LOCAL_PG_HOST" -p "$LOCAL_PG_PORT" -U "$LOCAL_PG_USER" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${BUCARDO_DB_NAME}\";"
else
  log "Bucardo control database '${BUCARDO_DB_NAME}' already exists."
fi

# 3) Install Bucardo into the control DB (idempotent)
BUCARDO_CLI_ARGS=(
  --dbhost="${BUCARDO_DB_HOST}"
  --dbport="${BUCARDO_DB_PORT}"
  --dbname="${BUCARDO_DB_NAME}"
  --dbuser="${BUCARDO_DB_USER}"
  --dbpass="${BUCARDO_DB_PASS}"
)

if bucardo "${BUCARDO_CLI_ARGS[@]}" list config >/dev/null 2>&1; then
  log "Bucardo appears to be installed already."
else
  log "Installing Bucardo into ${BUCARDO_DB_HOST}:${BUCARDO_DB_PORT}/${BUCARDO_DB_NAME}"
  if ! bucardo install --batch --quiet "${BUCARDO_CLI_ARGS[@]}"; then
    log "Note: bucardo install reported a non-zero exit; proceeding if already installed."
  fi
fi

# 4) Add databases to Bucardo (local + remote) if missing
if ! bucardo "${BUCARDO_CLI_ARGS[@]}" list db localdb >/dev/null 2>&1; then
  log "Adding Bucardo database 'localdb'"
  bucardo "${BUCARDO_CLI_ARGS[@]}" add db localdb dbname="${LOCAL_PG_DB}" host="${LOCAL_PG_HOST}" port="${LOCAL_PG_PORT}" user="${LOCAL_PG_USER}" pass="${LOCAL_PG_PASS}"
else
  log "Bucardo database 'localdb' already exists."
fi

if ! bucardo "${BUCARDO_CLI_ARGS[@]}" list db remotedb >/dev/null 2>&1; then
  log "Adding Bucardo database 'remotedb'"
  bucardo "${BUCARDO_CLI_ARGS[@]}" add db remotedb dbname="${REMOTE_PG_DB}" host="${REMOTE_PG_HOST}" port="${REMOTE_PG_PORT}" user="${REMOTE_PG_USER}" pass="${REMOTE_PG_PASS}"
else
  log "Bucardo database 'remotedb' already exists."
fi

# 5) Create relgroup and include tables + sequences from configured schemas
if ! bucardo "${BUCARDO_CLI_ARGS[@]}" list relgroup "${RELGROUP}" >/dev/null 2>&1; then
  log "Creating relgroup '${RELGROUP}'"
  bucardo "${BUCARDO_CLI_ARGS[@]}" add relgroup "${RELGROUP}"
else
  log "Relgroup '${RELGROUP}' already exists."
fi

# Build exclusion set into grep regex
IFS=',' read -r -a exclude_list <<<"${EXCLUDE_TABLES}"
exclude_regex="^$" # matches nothing by default
if ((${#exclude_list[@]} > 0)); then
  exclude_regex=$(printf "(%s)" "$(IFS='|'; echo "${exclude_list[*]}")")
fi

# Enumerate tables in selected schemas from LOCAL and add to relgroup
log "Enumerating tables in schemas: ${SYNC_SCHEMAS}"
table_query=$(cat <<SQL
SELECT quote_ident(schemaname)||'.'||quote_ident(tablename)
FROM pg_catalog.pg_tables
WHERE schemaname = ANY(string_to_array('${SYNC_SCHEMAS}', ','))
ORDER BY 1;
SQL
)

tables=$(psql -h "$LOCAL_PG_HOST" -p "$LOCAL_PG_PORT" -U "$LOCAL_PG_USER" -d "$LOCAL_PG_DB" -At -c "$table_query" | grep -Ev "${exclude_regex}" || true)

added_any=false
while IFS= read -r tbl; do
  [[ -z "$tbl" ]] && continue
  log "Adding table to relgroup: $tbl"
  if bucardo "${BUCARDO_CLI_ARGS[@]}" add table "$tbl" relgroup="${RELGROUP}" >/dev/null 2>&1; then
    added_any=true
  fi
done <<<"$tables"

# Add sequences (best-effort; safe if none)
seq_query=$(cat <<SQL
SELECT quote_ident(sequence_schema)||'.'||quote_ident(sequence_name)
FROM information_schema.sequences
WHERE sequence_schema = ANY(string_to_array('${SYNC_SCHEMAS}', ','))
ORDER BY 1;
SQL
)
sequences=$(psql -h "$LOCAL_PG_HOST" -p "$LOCAL_PG_PORT" -U "$LOCAL_PG_USER" -d "$LOCAL_PG_DB" -At -c "$seq_query" || true)
while IFS= read -r seq; do
  [[ -z "$seq" ]] && continue
  log "Adding sequence to relgroup: $seq"
  bucardo "${BUCARDO_CLI_ARGS[@]}" add sequence "$seq" relgroup="${RELGROUP}" >/dev/null 2>&1 || true
done <<<"$sequences"

# 6) Create sync (bidirectional) with last-write-wins style strategy
if ! bucardo "${BUCARDO_CLI_ARGS[@]}" list sync "${SYNC_NAME}" >/dev/null 2>&1; then
  log "Creating sync '${SYNC_NAME}' for relgroup '${RELGROUP}'"
  # Multi-master: both DBs as sources. Enable autokick. Seed copy from both sides (onetimecopy=2) for initial convergence.
  bucardo "${BUCARDO_CLI_ARGS[@]}" add sync "${SYNC_NAME}" relgroup="${RELGROUP}" dbs=localdb:source,remotedb:source autokick=true onetimecopy=2 conflict_strategy="${CONFLICT_STRATEGY}" >/dev/null 2>&1 || {
    log "Warning: 'add sync' with conflict strategy may have partially applied; continuing."
  }
  # Attempt to set a preferred conflict column if supported
  bucardo "${BUCARDO_CLI_ARGS[@]}" update sync "${SYNC_NAME}" conflict_strategy="${CONFLICT_STRATEGY}" >/dev/null 2>&1 || true
else
  log "Sync '${SYNC_NAME}' already exists."
fi

# 7) Start and keep foreground active for container liveness
log "Starting Bucardo daemon (idempotent)"
bucardo "${BUCARDO_CLI_ARGS[@]}" start >/dev/null 2>&1 || true

log "Entering status loop (60s interval). Ctrl-C to exit."
exec bucardo "${BUCARDO_CLI_ARGS[@]}" status --loop 60
