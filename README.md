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
mkdir -p "${STACK_ROOT:-.}/.secrets" && read -s "PW?DB password: " && umask 077 && printf '%s' "$PW" > "${STACK_ROOT:-.}/.secrets/db_password.txt" && chmod 600 "${STACK_ROOT:-.}/.secrets/db_password.txt" && unset PW
read -s "URL?Database URL (postgresql://...): " && umask 077 && printf '%s' "$URL" > "${STACK_ROOT:-.}/.secrets/database_url.txt" && chmod 600 "${STACK_ROOT:-.}/.secrets/database_url.txt" && unset URL
```

bash
```
mkdir -p "${STACK_ROOT:-.}/.secrets"; read -s -p 'DB password: ' PW; echo; umask 077; printf '%s' "$PW" > "${STACK_ROOT:-.}/.secrets/db_password.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/db_password.txt"; unset PW
read -s -p 'Database URL (postgresql://...): ' URL; echo; umask 077; printf '%s' "$URL" > "${STACK_ROOT:-.}/.secrets/database_url.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/database_url.txt"; unset URL
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
  # Required: who owns the images in GHCR (lowercase)
  export GHCR_OWNER=<your-org-or-username>
  # Required: who logs in to GHCR (can be the same as owner)
  export GHCR_USER=<your-gh-username>

```

#### Setup container use on HPC

##### 1) Build api and app docker images locally and push to GHCR

Prereqs
- Create a GitHub Personal Access Token with `write:packages` (and `read:packages` to pull).
- Login `docker login ghcr.io -u "$GHCR_USER"` locally

##### 2) set the required

```
bun run build:docker
```

Notes
- The app build reads `.env` at build time (Vite). Ensure the build-arg values match the runtime endpoints you intend to use.
- If you prefer, you can source your `.env` and pass values in `--build-arg` from that file.

##### 3) Pre-pull images (offline-friendly)

Place the `.sif` files under `$STACK_ROOT`.

```
# Public registries (explicit amd64)
apptainer pull --arch amd64 "$STACK_ROOT/postgres_18.sif" docker://docker.io/library/postgres:18
apptainer pull --arch amd64 "$STACK_ROOT/vllm_openai_latest.sif" docker://vllm/vllm-openai:latest

# GHCR (login first on remote)
apptainer registry login ghcr.io -u "$GHCR_USER"
apptainer pull --arch amd64 "$STACK_ROOT/api_server.sif" docker://ghcr.io/$GHCR_OWNER/api-server:$TAG
apptainer pull --arch amd64 "$STACK_ROOT/app_server.sif" docker://ghcr.io/$GHCR_OWNER/app-server:$TAG
```

Tip: the `--profile hostnet` compose setup on Linux behaves like Apptainer’s host networking, so you can validate localhost-based URLs locally before deploying.

##### 4) Provide secrets

Create the secrets files used by the host‑network/Apptainer flow. These are one‑line files with strict perms.

###### Postgres password (`POSTGRES_PASSWORD_FILE`):

```bash
mkdir -p "${STACK_ROOT:-.}/.secrets"; read -s -p 'DB password: ' PW; echo; umask 077; printf '%s' "$PW" > "${STACK_ROOT:-.}/.secrets/db_password.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/db_password.txt"; unset PW
```

###### Database URL for the API (`DATABASE_URL_FILE`):

``` bash
mkdir -p "${STACK_ROOT:-.}/.secrets"; read -s -p "Database URL (postgresql://user:pass@localhost:${POSTGRES_PORT:-5432}/${DB_NAME:-postgres}): " URL; echo; umask 077; printf '%s' "$URL" > "${STACK_ROOT:-.}/.secrets/database_url.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/database_url.txt"; unset URL
```

###### Optional Better Auth secrets (supported via `*_FILE` fallbacks):

``` bash
read -s -p 'Better Auth secret: ' S; echo; umask 077; printf '%s' "$S" > "${STACK_ROOT:-.}/.secrets/better_auth_secret.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/better_auth_secret.txt"; unset S
read -s -p 'Better Auth URL (https://...): ' U; echo; umask 077; printf '%s' "$U" > "${STACK_ROOT:-.}/.secrets/better_auth_url.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/better_auth_url.txt"; unset U
```

Notes
- The VLLM key (`VLLM_API_KEY`) is read from env; you can export it in your shell or pass it with `--env VLLM_API_KEY=...` when starting `vllm`.
- We'll remove VLLM_API_KEY from env eventually.

### 3) Run the SIFs (no registry access required)

DB (Postgres)
``` bash
apptainer run --net --network=host \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=appdb \
  --bind $STACK_ROOT/pgdata:/var/lib/postgresql/data \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  $STACK_ROOT/postgres_18.sif
```

# Optional: verify your model path exists
```
ls -al "$STACK_ROOT/models/Qwen3-32B-FP8" || true
```

VLLM (GPU)
``` bash
apptainer run --nv --net --network=host \
  --bind $STACK_ROOT/models:/models:ro \
  $STACK_ROOT/vllm_openai_latest.sif \
  vllm serve /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --api-key "$VLLM_API_KEY"
```

API
``` bash
apptainer run --net --network=host \
  --bind ${STACK_ROOT:-.}/.secrets/database_url.txt:/run/secrets/database_url:ro \
  --env DATABASE_URL_FILE=/run/secrets/database_url \
  --env VITE_LLM_SERVER_URL=http://localhost:8000/v1 \
  --env API_SERVER_PORT=3000 \
  $STACK_ROOT/api_server.sif
```
Replace 5432 in your `${STACK_ROOT:-.}/.secrets/database_url.txt` if you changed `POSTGRES_PORT`.

App
``` bash
apptainer run --net --network=host \
  --env SERVER_HOST=localhost --env API_SERVER_PORT=3000 \
  --env PROD_SERVER=8080 \
  $STACK_ROOT/app_server.sif
```

Verification helpers
```
# Check env inside the SIF
apptainer exec $STACK_ROOT/postgres_18.sif env | grep POSTGRES_PASSWORD_FILE

# Check the secret is mounted
apptainer exec \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  $STACK_ROOT/postgres_18.sif \
  sh -lc 'ls -l /run/secrets && head -c 5 /run/secrets/db_password && echo'
```

## Troubleshooting
  - Recreate database volume
    - Stop and remove containers and the named volume: `docker compose down -v`
    - Start again with your env: `docker compose --env-file .env.local up db`
  - Create the DB manually (alternative): `docker exec -it $(docker ps --filter name=db --format '{{.ID}}') psql -U ${DB_USER:-postgres} -c "CREATE DATABASE ${DB_NAME:-appdb};"`
