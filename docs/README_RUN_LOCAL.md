# Run local dev build

Current local-first flow. Core product config lives in the app, not `.env.local`.

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

## 2) Minimal `.env.local`

```bash
API_SERVER_PORT=3000
VITE_PORT=5173
# Optional if you do not want the default app-data DuckDB path
DUCKDB_PATH=~/forska/forska.duckdb
```

No provider/model settings, worker URLs, binary overrides, or contact emails belong here.

## 3) Initialize + start

```bash
bun run db:mig
bun run dev:server
bun run dev:app
```

Open `http://localhost:5173`.

## 4) Configure the app in the UI

- Add providers/models in `/admin/models`
- Set user-facing app settings in Forska Settings
- Keep core product behavior in the app, not env files

## 5) Optional remote inference

```bash
bun run alvis:dev:server
# or
bun run mn5:dev:server
```

Those launch helpers pass short-lived runtime metadata to the local API server. The provider/model still belongs in `/admin/models`.

## 6) Optional Docling

```bash
docker compose up docling
```

Then add a `Docling Serve` provider in `/providers`, add a manual model for it, and select that model in `/settings` as the PDF conversion model.

Optional runtime knobs:

```bash
RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true
FULL_TEXT_CONVERSION_BATCH_SIZE=5
FULL_TEXT_CONVERSION_CONCURRENCY=2
```
