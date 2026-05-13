# Run Local

This is the supported local development flow for Forska. Core product configuration lives in the app UI and local databases.

## Prerequisites

- Bun
- Optional local or remote model provider
- Optional local OpenAI-compatible inference endpoint

## Install

```bash
bun install
```

## Initialize The Database

```bash
bun run db:mig
```

## Start The App

Start the local API/server stack:

```bash
bun run dev:server
```

Start the web app:

```bash
bun run dev:app
```

Default local endpoints:

- Web app: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:3001`
- Runtime data: `data/runtime/primary/`

Open the local URL printed by Vite after `bun run dev:app` starts.

## Configure Providers

1. Open `/providers`.
2. Add a provider connection.
3. Open the provider and click `Test`.
4. Click `Sync Models` or `Add Model`.
5. Enable the models you want and click `Save Models`.
6. Set user-facing app settings in Forska Settings.

Do not create or edit `.env` files for normal local development.

## Optional Local Overrides

Most local users should not need environment variables. If you need a machine-local override, pass it inline with the command:

```bash
DUCKDB_PATH=~/forska/forska.duckdb bun run dev:server
```

Port overrides can be exported once per shell:

```bash
export VITE_PORT=3100
export API_SERVER_PORT=3101
export APP_SERVER_PORT=8180
```

Optional direct-origin frontend override:

```bash
VITE_SERVER_API=http://127.0.0.1:3001 bun run dev:app
```

## Optional Local Inference Endpoint

Forska can use a local OpenAI-compatible endpoint such as `llama-server`, LM Studio, Ollama, or another local provider.

For a local OpenAI-compatible endpoint, add a provider in `/providers` and set the base URL to the endpoint's `/v1` URL, for example:

```text
http://127.0.0.1:8080/v1
```

Then click `Test`, sync or manually add models, and enable the models you want.

## Optional Docling PDF Conversion

If you run a local Docling-compatible service, add it as a provider in `/providers`, add or sync the model, and select that model in `/settings` as the PDF conversion model.

Optional conversion worker knobs can be passed inline when starting the server:

```bash
RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true FULL_TEXT_CONVERSION_BATCH_SIZE=5 FULL_TEXT_CONVERSION_CONCURRENCY=2 bun run dev:server
```

## Build

Create a production build:

```bash
bun run build
```

Run the built app server stack:

```bash
bun run start
```

## Test And Lint

```bash
bun test
bun run lint
```
