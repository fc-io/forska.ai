# forska.ai

This is a really deep, "deep research agent". It's actively developed, it's going to be a lot of changes.
You can run it yourself if you have the chops. There will probably be a hosted version eventually.

It uses Elysia/Bun for the API server. Solid.js/Tanstack/Vite on the client. Uses Drizzle ORM with Postgres and Better Auth. It then hooks up to open ai compatible apis – vllm or something, to analyze data in various forms (though mainly research papers for the time being).

## Run local dev build

Prereqs
- Bun installed
- Docker (for local Postgres) and a GPU if you plan to run VLLM locally

### 1) Install dependencies

```
bun install
```

### 2) Configure env variables and  validate

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

### 3) Start Postgres (compose, bridge network)

Then start Postgres using `.env.local` for compose substitution:

```
docker compose --env-file .env.local up db
```

Note: Postgres uses a named Docker volume (`forska-stack_pgdata`) rather than a bind mount. This avoids filesystem issues with cloud‑synced folders (Dropbox/iCloud). You can inspect or remove it with `docker volume ls` and `docker volume rm forska-stack_pgdata`.

### 4) Start API and App in watch mode

```
bun run dev:server
bun run dev:app
```

Hit http://localhost:5173 in your browser for the web interface.

If you need the GPU-backed LLM locally, also start the `vllm` service via compose (see below).

## Run production builds

Two modes are available.

### Default – bridge network (recommended for local build on mac/windows, need a supported GPU if running VLLM)

- Start everything locally with inter-service DNS (`db`, `vllm`, `api-server`, `app-server`).
- Validate config: `docker compose --env-file .env.local config -q`
- Run command: `docker compose --env-file .env.local up`
- Endpoints:
  - App: http://localhost:8080
  - API: http://localhost:3000
  - VLLM: http://localhost:8000
  - Postgres: localhost:5432 (configurable via `POSTGRES_PORT`)

### Host networking – for HPCs running Apptainer

#### Secrets for hostnet profile

The hostnet profile uses secrets files (not env) for database credentials:

- Postgres reads its password via `POSTGRES_PASSWORD_FILE`.
- API reads its connection string via `DATABASE_URL_FILE`.
- Optional: `BETTER_AUTH_SECRET_FILE` and `BETTER_AUTH_URL_FILE` are also supported.

Safer one‑liners (no secret in history):

zsh
```
mkdir -p ./.secrets && read -s "PW?DB password: " && umask 077 && printf '%s' "$PW" > ./.secrets/db_password.txt && chmod 600 ./.secrets/db_password.txt && unset PW
read -s "URL?Database URL (postgresql://...): " && umask 077 && printf '%s' "$URL" > ./.secrets/database_url.txt && chmod 600 ./.secrets/database_url.txt && unset URL
```

bash
```
mkdir -p ./.secrets; read -s -p 'DB password: ' PW; echo; umask 077; printf '%s' "$PW" > ./.secrets/db_password.txt; chmod 600 ./.secrets/db_password.txt; unset PW
read -s -p 'Database URL (postgresql://...): ' URL; echo; umask 077; printf '%s' "$URL" > ./.secrets/database_url.txt; chmod 600 ./.secrets/database_url.txt; unset URL
```

#### Env vars hostnet profile

Required variables for hostnet runs (in `.env` or `.env.local`):

```
DB_NAME=postgres
DB_USER=postgres
VLLM_API_KEY=fake_key
POSTGRES_PORT=5432
# and some more that can be found in env.ts
```

Compared to running locally, do not set `DB_PASS` for hostnet – use the secrets files above instead.

#### Set shared path

Recommended shared paths and caches (for running on Alvis HPC, adapt to your setup)

```
export STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev; \
  mkdir -p $STACK_ROOT/{pgdata,models,hf_cache,logs,.cache} && echo $STACK_ROOT
export XDG_CACHE_HOME=$STACK_ROOT/.cache; \
  export VLLM_CACHE_ROOT=$XDG_CACHE_HOME/vllm; \
  export TORCHINDUCTOR_CACHE_DIR=$VLLM_CACHE_ROOT/torchinductor; \
  export TRITON_CACHE_DIR=$VLLM_CACHE_ROOT/triton; \
  export HF_HOME=$STACK_ROOT/hf_cache
```

#### Setup container use on HPC

##### 0) Build api and app docker images locally and put on your private registry

##### 1) Pre-pull images (offline-friendly)

Place the `.sif` files under `$STACK_ROOT`.

```
# Public registries (explicit amd64)
apptainer pull --arch amd64 "$STACK_ROOT/postgres_18.sif" docker://docker.io/library/postgres:18
apptainer pull --arch amd64 "$STACK_ROOT/vllm_openai_latest.sif" docker://vllm/vllm-openai:latest

# GHCR (login first if private)
apptainer registry login ghcr.io -u "$GHCR_USER"
apptainer pull --arch amd64 "$STACK_ROOT/images/api_server_${TAG}.sif" docker://ghcr.io/$GHCR_OWNER/api-server:$TAG
apptainer pull --arch amd64 "$STACK_ROOT/images/app_server_${TAG}.sif" docker://ghcr.io/$GHCR_OWNER/app-server:$TAG
```

Tip: the `--profile hostnet` compose setup on Linux behaves like Apptainer’s host networking, so you can validate localhost-based URLs locally before deploying.

### 2) Provide secrets (Postgres password file)

The official Postgres image supports `POSTGRES_PASSWORD_FILE`. Create a one-line secret and restrict permissions:
zsh (no secret in history)
```
mkdir -p "$HOME/.secrets" && read -s "PW?Postgres password: " && umask 077 && printf '%s' "$PW" > "$HOME/.secrets/pg_password" && chmod 600 "$HOME/.secrets/pg_password" && unset PW
```

bash (no secret in history)
```
mkdir -p "$HOME/.secrets"; read -s -p 'Postgres password: ' PW; echo; umask 077; printf '%s' "$PW" > "$HOME/.secrets/pg_password"; chmod 600 "$HOME/.secrets/pg_password"; unset PW
```

### 3) Run the SIFs (no registry access required)

DB (Postgres)
```
apptainer run --net --network=host \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/pg_password \
  --env POSTGRES_DB=appdb \
  --bind $STACK_ROOT/pgdata:/var/lib/postgresql/data \
  --bind $HOME/.secrets/pg_password:/run/secrets/pg_password:ro \
  $STACK_ROOT/images/postgres_18.sif
```

# Optional: verify your model path exists
ls -al "$STACK_ROOT/models/Qwen3-32B-FP8" || true
```

VLLM (GPU)
```
apptainer run --nv --net --network=host \
  --bind $STACK_ROOT/models:/models:ro \
  $STACK_ROOT/images/vllm_openai_latest.sif \
  vllm serve /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --api-key "$VLLM_API_KEY"
```

API
```
apptainer run --net --network=host \
  --bind $STACK_ROOT/.secrets/database_url.txt:/run/secrets/database_url:ro \
  --env DATABASE_URL_FILE=/run/secrets/database_url \
  --env VITE_LLM_SERVER_URL=http://localhost:8000/v1 \
  --env API_SERVER_PORT=3000 \
  $STACK_ROOT/images/api_server_${TAG}.sif
```
Replace 5432 in your `.secrets/database_url.txt` if you changed `POSTGRES_PORT`.

App
```
apptainer run --net --network=host \
  --env SERVER_HOST=localhost --env API_SERVER_PORT=3000 \
  --env PROD_SERVER=8080 \
  $STACK_ROOT/images/app_server_${TAG}.sif
```

Verification helpers
```
# Check env inside the SIF
apptainer exec $STACK_ROOT/images/postgres_18.sif env | grep POSTGRES_PASSWORD_FILE

# Check the secret is mounted
apptainer exec \
  --bind $HOME/.secrets/pg_password:/run/secrets/pg_password:ro \
  $STACK_ROOT/images/postgres_18.sif \
  sh -lc 'ls -l /run/secrets && head -c 5 /run/secrets/pg_password && echo'
```

Optional — Docker save/load (if you must use Docker on airgapped hosts)
```
# On a networked machine
docker pull ghcr.io/$GHCR_OWNER/api-server:$TAG
docker pull ghcr.io/$GHCR_OWNER/app-server:$TAG
docker save -o api-server_$TAG.tar ghcr.io/$GHCR_OWNER/api-server:$TAG
docker save -o app-server_$TAG.tar ghcr.io/$GHCR_OWNER/app-server:$TAG

# On the target host(s)
docker load -i api-server_$TAG.tar
docker load -i app-server_$TAG.tar
```

## Build and Push to GHCR (hostnet runtime)

Host networking is a runtime setting; you don’t need a special build. Build the same images and run them with host networking (Compose hostnet profile or Apptainer `--network=host`). Use the Compose path below to build and push to GitHub Container Registry (ghcr.io).

Prereqs
- Create a GitHub Personal Access Token with `write:packages` (and `read:packages` to pull).
- Quick-setup environment (adjust values to your repo/org):
```
# Required: who owns the images in GHCR (lowercase)
export GHCR_OWNER=your-org-or-username

# Required: who logs in to GHCR (can be the same as owner)
export GHCR_USER=your-gh-username

# Required: GitHub PAT with write:packages
export GHCR_TOKEN=ghp_xxx

# Recommended: consistent tag for both images
# Use a version:
# export TAG=v0.1.0
# Or a git SHA (default suggestion):
export TAG=$(git rev-parse --short HEAD)
# Or a datestamp:
# export TAG=$(date +%Y%m%d-%H%M%S)
```

Login
```
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
```

Build via Compose (uses hostnet service configs)
```
# Build the hostnet variants (Linux only)
docker compose --profile hostnet build api-server-hostnet app-server-hostnet

# Push directly with Compose (requires GHCR_OWNER and TAG)
docker compose --profile hostnet push api-server-hostnet app-server-hostnet
```

Notes
- The same image works for both bridge and host networking; the difference is in how you run it.
- The app build reads env at build time (Vite). Ensure the build-arg values match the runtime endpoints you intend to use.
- If you prefer, you can source your `.env` and pass values in `--build-arg` from that file.

## Troubleshooting

- Postgres logs: `FATAL:  database "appdb" does not exist`
  - Cause: the healthcheck previously targeted a hardcoded `appdb` DB. It now respects `DB_NAME` from your env. Ensure your Compose run uses the intended env file for substitution (e.g., `--env-file .env.local`).
  - Align DB name: set `DB_NAME` in your env file to match the database that exists in the `pgdata` volume (commonly `postgres`). Example: `DB_NAME=postgres`.
  - Recreate database volume (if you want to switch DB names cleanly):
    - Stop and remove containers and the named volume: `docker compose down -v`
    - Start again with your env: `docker compose --env-file .env.local up db`
  - Create the DB manually (alternative): `docker exec -it $(docker ps --filter name=db --format '{{.ID}}') psql -U ${DB_USER:-postgres} -c "CREATE DATABASE ${DB_NAME:-appdb};"`
