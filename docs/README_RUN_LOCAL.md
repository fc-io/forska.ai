# Run local dev build

Current local-first flow. Core product config lives in the app.

Legacy note

- Old Docker/Postgres docs/scripts still exist for repair/import work. Ignore them for normal app use.

Prereqs

- Bun
- Optional: Docker for Docling
- Optional: local/manual inference or a remote HPC runtime

## 1) Install

```bash
bun install
```

## 2) Initialize DB

```bash
bun run db:mig
```

## 3) Start dev servers

Terminal 1:

```bash
bun run dev:server
```

Terminal 2:

```bash
bun run dev:app
```

Open the local URL printed by Vite. Default local dev ports: app `3000`, API `3001`.

Do not create or edit `.env` files for normal local dev.

If you need a machine-local override, pass it inline:

```bash
DUCKDB_PATH=~/forska/forska.duckdb bun run dev:server
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

## 5) Optional remote inference

```bash
bun run alvis:dev:server
# or
bun run mn5:dev:server
```

Those launch helpers pass short-lived runtime metadata to the local API server. The provider connection and model still belong in `/providers`.

## 6) Optional Docling

```bash
docker compose up docling
```

Then add a `Docling Serve` provider in `/providers`, add a manual model for it, and select that model in `/settings` as the PDF conversion model.

Optional runtime knobs. Pass inline, do not store in `.env`:

```bash
RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true FULL_TEXT_CONVERSION_BATCH_SIZE=5 FULL_TEXT_CONVERSION_CONCURRENCY=2 bun run dev:server
```

## Allowed env surface

Most local users should not set any env vars beyond one-off inline overrides.

- Bootstrap and local paths: `DUCKDB_PATH`, `DUCKDB_MEMORY_LIMIT`, `DUCKDB_TEMP_DIRECTORY`, `DUCKDB_APPEND_LANE_COUNT`
- Local dev wiring: `VITE_PORT`, `API_SERVER_PORT`, `VITE_SERVER_API`
- App server wiring: `APP_SERVER_API_HOST`, `APP_SERVER_API_PORT`, `APP_SERVER_API_SCHEME`, `APP_SERVER_DIST_DIR`, `APP_SERVER_PORT`
- Advanced server role wiring: `SERVER_ROLE`, `SERVER_WRITER_URL`
- Background job toggles: `RUN_SERVER_FULL_TEXT_FETCHING`, `RUN_SERVER_FULL_TEXT_CONVERSION_CRON`, `FULL_TEXT_CONVERSION_BATCH_SIZE`, `FULL_TEXT_CONVERSION_CONCURRENCY`
- Runtime and launcher metadata: `FORSKA_RUNTIME_*`, `GPU_*`, `TP_SIZE`, `PP_SIZE`, `DP_SIZE`, `NVIDIA_SMI_WORKER_URLS`, `NVIDIA_SMI_WORKER_URLS_LOCAL`, `NVIDIA_SMI_SSH_JUMP_HOST`
- Scheduler and transport tuning: `CODEX_MAX_INFLIGHT`, `JUDGE_CHUNK_MAX_PARALLEL`, `JUDGE_FIRST_REQUEST_LOG_FULL`, `JUDGE_FIRST_REQUEST_PREVIEW_CHARS`, `JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE`, `JUDGMENTS_READY_TARGET_MULTIPLIER`, `SGLANG_API_MAX_BURST_REQUESTS`, `SGLANG_API_MAX_INFLIGHT_REQUESTS`, `SGLANG_MAX_RUNNING_REQUESTS`, `BUN_CONFIG_MAX_HTTP_REQUESTS`
