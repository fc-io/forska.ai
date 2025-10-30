# Database Merge From Remote Dump

This documents how to merge rows from a previously created remote Postgres dump into your local database using Bun and Docker Compose.

## Prerequisites

- Docker Compose Postgres service `db` running locally: `docker compose up -d db`
- `.env.local` contains: `DB_NAME`, `DB_USER`, `DB_PASS` (and optionally `POSTGRES_PORT`)
- Latest remote dump present in `backups/` with the pattern `dump_remote_<db>_<timestamp>.dump`
  - Example: `backups/dump_remote_postgres_20251028_164459.dump`
- Bun installed (`bun --version`) and project deps installed (`bun install`)

Note: The merge uses `postgres_fdw` inside the container. Your DB user must be allowed to `CREATE EXTENSION` (the default `postgres` superuser works). Inside the container the Postgres port is `5432`; if your host port differs, that is fine — the script connects internally.

## What the merge does

- Backs up your local DB to `backups/dump_local_<db>_<timestamp>.dump`
- Restores the latest `backups/dump_remote_*.dump` into a temporary DB inside the container
- Uses `postgres_fdw` to import the remote schema into `import_tmp`
- For each table that exists locally and has a primary key:
  - Inserts missing rows and updates matching rows using `INSERT ... ON CONFLICT ... DO UPDATE`
  - Updates only changed columns (`IS DISTINCT FROM` guards no-op updates)
- Adjusts sequences (serial/identity) to the current max values
- Cleans up the FDW objects and drops the temporary DB

## Quick start

1) Ensure the DB is running

```bash
docker compose up -d db
```

2) Place or verify the latest remote dump in `backups/` (must match `dump_remote_*.dump`)

3) Run the merge

```bash
bun run db:merge:remote
```

You will be asked to confirm the selected dump. Use `--yes` to skip the prompt:

```bash
bun run db:merge:remote --yes
```

## Rollback

The merge creates a local backup before applying changes. To restore it:

```bash
# pick the backup file created just before the merge
BACKUP=backups/dump_local_<db>_<timestamp>.dump

# copy it into the container
docker compose cp "$BACKUP" db:/tmp/backup.dump

# restore (drops/recreates objects per dump contents)
docker compose exec -T -e PGPASSWORD="$DB_PASS" db \
  pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner --no-privileges /tmp/backup.dump
```

## Notes and caveats

- Only tables that already exist locally and have a primary key are merged
- Schema differences are not migrated; columns must be compatible for inserts/updates
- Very large dumps can take time and disk space; ensure `backups/` has room
- The chosen dump remains in `backups/`; the script cleans up only temp DB/FDW resources

## Where to look

- Merge script: `scripts/dbMergeRemoteDump.ts`
- Script alias: `package.json` → `scripts.db:merge:remote`

