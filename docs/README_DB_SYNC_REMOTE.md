# Remote → Local Delta Sync (FDW)

This sync pulls data from a remote Postgres through an SSH tunnel and upserts into the local database using `postgres_fdw`. It updates rows by primary key and adjusts sequences. All tables are supported: tables with `updated_at` are synced incrementally; tables without `updated_at` are fully upserted.

## Prerequisites
- Local DB is running: `docker compose up -d db`
- `.env.local` contains required DB vars (`DB_NAME`, `DB_USER`, `DB_PASS`, `POSTGRES_PORT`, etc.)
- Remote Postgres is reachable through an SSH tunnel, and you have a URL for it via `REMOTE_DATABASE_URL`.

## Create the SSH tunnel
Pick a local port (e.g., 8432) and forward to the remote Postgres (commonly 5433 on the HPC container):

- Alvis
```bash
ssh -N -L 8432:127.0.0.1:5433 alvis2
```
- Discoverer
```bash
ssh -N -L 8432:127.0.0.1:5433 dis
```

If the port is taken:
```bash
lsof -iTCP:8432 -sTCP:LISTEN -Pn
```

## Configure the remote URL
Set `REMOTE_DATABASE_URL` to the tunneled endpoint (on your host):
```
REMOTE_DATABASE_URL=postgres://postgres:***@localhost:8432/postgres
```
Note: The sync runs inside the local `db` container. When `REMOTE_DATABASE_URL` points at `localhost`/`127.0.0.1`, the container will automatically use `host.docker.internal` to reach your host’s forwarded port. If your Docker setup doesn’t support that, set `REMOTE_FDW_HOST` to your host gateway IP (e.g., `172.17.0.1`).

Optional identifiers and filters:
- `REMOTE_ID`: label for this remote in the `sync_state` watermark table. Default: `<host>:<port>/<db>`.

## Run the sync
```bash
bun run db:sync:remote
```
- Delta mode: Tables with `updated_at` only pull rows where remote `updated_at` > last watermark.
- Full mode: Use `--full` to upsert all rows for all tables (skips the watermark).
- Subset: `--tables=table1,table2` to limit which tables are processed.

Examples:
```bash
# Delta sync everything (default)
bun run db:sync:remote

# Full upsert of all tables
bun run db:sync:remote --full

# Only a couple of tables (delta)
bun run db:sync:remote --tables=articles,judgments
```

## What it does
- Ensures local DB is up and schema exists (run migrations before first sync).
- Creates `sync_state(remote_id, table_name, last_synced_at)` to track per-table watermarks.
- Establishes `postgres_fdw` connection to the remote and imports tables into `import_remote` schema.
- For each intersecting table (present on both sides):
  - If `updated_at` exists on both sides, delta upsert from the last watermark.
  - Otherwise, full upsert for that table.
- Adjusts sequences for affected tables.
- Cleans up FDW objects (`import_remote` schema and server).

## Notes and limits
- Upsert-only: Deletes on the remote are not propagated (by design). If you need deletes, consider adding a CDC/outbox pattern or a soft-delete column and mirror that state.
- Performance: Ensure indexes on `updated_at` for big tables to keep delta scans fast. For very large tables without `updated_at`, consider adding one or partitioning.
- Tunnels: Keep the SSH tunnel open during the sync. If it drops, re-run the sync; upserts are idempotent.

## Troubleshooting
- Container cannot reach the tunnel on `localhost`:
  - Set `REMOTE_FDW_HOST` to your host gateway (e.g., `REMOTE_FDW_HOST=host.docker.internal` on Docker Desktop, or `REMOTE_FDW_HOST=172.17.0.1` on Linux).
- Missing schema/enum types:
  - Run `bun run db:mig` (and `bun run db:ba-mig` if you use auth) so local types match before syncing.

