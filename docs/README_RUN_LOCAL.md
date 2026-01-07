# Run local dev build

Prereqs
- Bun installed
- Docker
- A GPU if you plan to run VLLM locally
- The cloned repo on you machine

## 1) Install dependencies


``` bash
# cd into the project folder, then:
bun install
```

## 2) Configure env variables and  validate

Create `.env.local` (gitignored) and set required values. At minimum:

```
DB_NAME=postgres
DB_USER=postgres
DB_PASS=change-me
VLLM_API_KEY=fake_key
POSTGRES_PORT=5432
# and some more that can be found in env.ts
```

Validate your Compose config (optional – shows no output if correct):

```
docker compose --env-file .env.local config -q
```

## 3) Start Postgres

Then start Postgres using `.env.local` for compose substitution:

```
docker compose --env-file .env.local up db
```

## 4) Start API and App in watch mode

```
bun run dev:server
bun run dev:app
```

Hit http://localhost:5173 in your browser for the web interface.

If you need the GPU-backed LLM locally, also start the `vllm` service via compose (see below).

## PDF conversion (Docling)

Start Docling (optional):

`docker compose --env-file .env.local up docling`

Enable + tune conversion throughput (in `.env.local`):

`RUN_SERVER_FULL_TEXT_CONVERSION_CRON=true`
`FULL_TEXT_CONVERSION_BATCH_SIZE=5`
`FULL_TEXT_CONVERSION_CONCURRENCY=2`
