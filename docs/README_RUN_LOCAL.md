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

Optional runtime knobs. Pass inline, do not store in `.env`:

```bash
RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true FULL_TEXT_CONVERSION_BATCH_SIZE=5 FULL_TEXT_CONVERSION_CONCURRENCY=2 bun run dev:server
```
