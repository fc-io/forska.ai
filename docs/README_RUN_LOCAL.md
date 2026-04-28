# Run local dev build

Current local-first flow. Core product config lives in the app.

Legacy note

- Old Docker/Postgres docs/scripts still exist for repair/import work. Ignore them for normal app use.

Prereqs

- Bun
- Optional: Docker for Docling
- Optional: local/manual inference endpoint

## 1) Install

```bash
bun install
```

## 2) Initialize DB

```bash
bun run db:mig
```

Primary is implicit. Secondary is explicit:

```bash
bun run db:mig:secondary
```

## 3) Start dev servers

Primary profile commands:

```bash
bun run dev:server
bun run dev:app
```

Ports and storage:

- Primary app `3000`, API `3001`, DuckDB owner `3002`
- Primary judge worker `3003`
- Primary runtime root `data/runtime/primary/`

Secondary profile commands:

```bash
bun run dev:secondary:server
bun run dev:secondary:app
```

Ports and storage:

- Secondary app `3100`, API `3101`, DuckDB owner `3102`
- Secondary judge worker `3103`
- Secondary runtime root `data/runtime/secondary/`

DuckDB and judgment-job SQLite isolation come from those separate profile roots. Each profile keeps its own `forska.duckdb` and adjacent runtime state under its own `data/runtime/<profile>/` directory.

Split API, maintenance, and judge commands:

```bash
# primary
bun run dev:server:api
bun run dev:server:maintenance
bun run dev:server:judge

# secondary
bun run dev:secondary:server:api
bun run dev:secondary:server:maintenance
bun run dev:secondary:server:judge
```

Built app commands:

```bash
# primary
bun run start
bun run start:server
bun run start:app-server

# secondary
bun run start:secondary
bun run start:secondary:server
bun run start:secondary:app-server
```

Open the local URL printed by Vite for dev mode, or the app server URL for built mode.

Split runtime cutover and failure drills are documented in [SPLIT RUNTIME VERIFICATION](./README_SPLIT_RUNTIME_VERIFICATION.md).

Do not create or edit `.env` files for normal local dev.

If you need a machine-local override, pass it inline:

```bash
DUCKDB_PATH=~/forska/forska.duckdb bun run dev:server
```

Or export once per shell:

```bash
export VITE_PORT=3100
export API_SERVER_PORT=3101
export APP_SERVER_PORT=8180
```

Optional direct-origin frontend override:

```bash
VITE_SERVER_API=http://localhost:3004 bun run dev:app
```

## 4) Configure the app in the UI

- Open `/providers`
- Add provider connections there
- Open each provider, then `Test` and `Sync Models` or `Add Model`
- Enable the models you want and click `Save Models`
- Set user-facing app settings in Forska Settings
- Keep core product behavior in the app, not env files

## 5) Optional Docling

```bash
docker compose up docling
```

Then add a `Docling Serve` provider in `/providers`, add a manual model for it, and select that model in `/settings` as the PDF conversion model.

Optional runtime knobs. Pass inline, do not store in `.env`:

```bash
RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true FULL_TEXT_CONVERSION_BATCH_SIZE=5 FULL_TEXT_CONVERSION_CONCURRENCY=2 bun run dev:server
```

## Project mart large rebuild tuning

Use shell env only for one-off tuning runs. The portable shipped defaults are:

- `PROJECT_MART_LARGE_REBUILD_BATCH_SIZE=128`
- `PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS=1000`
- `PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE=4`
- Maintenance DuckDB memory limit selection:
  - `BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT` wins when set.
  - Otherwise `DUCKDB_MEMORY_LIMIT` is reused when set.
  - Otherwise the maintenance runtime derives its limit from host RAM as about half of total memory, clamped between `4GB` and `20GB`.

Recommended profiles:

- Portable default profile:

```bash
bun run dev:server
```

- Stronger catch-up profile for larger-memory hosts:
  - Good starting point for `>=32GB` machines when a rebuild needs to drain obvious backlog.

```bash
BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT=12GB \
PROJECT_MART_LARGE_REBUILD_BATCH_SIZE=512 \
PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS=500 \
PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE=8 \
bun run dev:server
```

- Conservative profile for smaller machines:
  - Good starting point for `8-16GB` laptops when you want to protect interactivity.

```bash
BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT=4GB \
PROJECT_MART_LARGE_REBUILD_BATCH_SIZE=64 \
PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS=1500 \
PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE=2 \
bun run dev:server
```

Live signals to watch while tuning:

- Maintenance memory and effective DuckDB runtime:
  - `curl -s http://127.0.0.1:3001/api/admin/maintenance-runtime-diagnostics`
  - Watch `processMemory.rssBytes`, the effective DuckDB `memoryLimit`, and `tempDirectory`.
- Rebuild burst behavior:
  - The maintenance log prints `batch_size`, `max_cycles_per_wake`, and `poll_interval_ms` when the heartbeat starts.
  - `projectMartLargeRebuildRuntimeMetrics.recentCycles` shows whether one wake is processing multiple consecutive cycles and whether work is landing on the background queue.
- DuckDB queue contention:
  - From the same diagnostics response, watch `projectMartLargeRebuildRuntimeMetrics.recentCycles[].duckdbQueues.background` and `.main` for queue depth, wait time, and task deltas.
- Rebuild progress:
  - `curl -s "http://127.0.0.1:3001/api/admin/project-mart-large-rebuild-status?projectId=<project-id>"`
  - Watch the cursor fields and phase progress estimates to confirm the rebuild keeps moving.
- SQLite drain health:
  - Open `/admin/jobs/<job-id>` and watch `Last ACK seq` and `Retained` under Local Storage Health.
  - A healthy catch-up run makes `lastAckSeq` move and `retainedRowCount` trend down.
- Temp spill and user impact:
  - Watch the DuckDB temp directory size on disk and keep it from growing explosively.
  - Check that API requests stay responsive while the rebuild is active.

Practical tuning loop:

- If `rssBytes` stays stable, temp spill stays flat, and API latency is acceptable, raise batch size first.
- If one wake still only clears a little visible work, raise `PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE` before pushing memory harder.
- If temp growth jumps or API latency regresses, step batch size or per-wake burst back down.
- Change `BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT` only after the faster batch and wake settings still leave the maintenance runtime clearly memory-bound.

## Allowed env surface

Most local users should not set any env vars beyond one-off inline overrides.

- Bootstrap and local paths: `DUCKDB_PATH`, `DUCKDB_MEMORY_LIMIT`, `DUCKDB_TEMP_DIRECTORY`, `DUCKDB_APPEND_LANE_COUNT`
- Local dev wiring: `VITE_PORT`, `API_SERVER_PORT`, `VITE_SERVER_API`
- App server wiring: `APP_SERVER_API_HOST`, `APP_SERVER_API_PORT`, `APP_SERVER_API_SCHEME`, `APP_SERVER_DIST_DIR`, `APP_SERVER_PORT`
- Advanced server role wiring: `SERVER_ROLE`, `SERVER_DUCKDB_OWNER_URL`
- Background job toggles: `RUN_SERVER_FULL_TEXT_FETCHING`, `RUN_SERVER_FULL_TEXT_CONVERSION_CRON`, `FULL_TEXT_CONVERSION_BATCH_SIZE`, `FULL_TEXT_CONVERSION_CONCURRENCY`
- Project mart rebuild tuning: `PROJECT_MART_LARGE_REBUILD_BATCH_SIZE`, `PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS`, `PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE`, `BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT`
- Scheduler and transport tuning: `CODEX_MAX_INFLIGHT`, `JUDGE_CHUNK_MAX_PARALLEL`, `JUDGE_FIRST_REQUEST_LOG_FULL`, `JUDGE_FIRST_REQUEST_PREVIEW_CHARS`, `JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE`, `JUDGMENTS_READY_TARGET_MULTIPLIER`, `BUN_CONFIG_MAX_HTTP_REQUESTS`
