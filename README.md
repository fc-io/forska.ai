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

For Slurm batch job examples using Apptainer, see [README_SBATCH.md](./README_SBATCH.md).

#### Secrets for hostnet profile

The hostnet profile uses secrets files (not env) for database credentials:

- Postgres reads its password via `POSTGRES_PASSWORD_FILE`.
- API reads its connection string via `DATABASE_URL_FILE`.
- Optional: `BETTER_AUTH_SECRET_FILE` and `BETTER_AUTH_URL_FILE` are also supported.

Safer one‑liners (no secret in history):


``` bash
mkdir -p "${STACK_ROOT:-.}/.secrets"; read -s -p 'DB password: ' PW; echo; umask 077; printf '%s' "$PW" > "${STACK_ROOT:-.}/.secrets/db_password.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/db_password.txt"; unset PW
read -s -p 'Database URL (postgresql://...): ' URL; echo; umask 077; printf '%s' "$URL" > "${STACK_ROOT:-.}/.secrets/database_url.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/database_url.txt"; unset URL
```

#### Env vars hostnet profile

Required variables for hostnet runs (in `.env` or `.env.local`):

``` bash
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
```
``` bash
read -s -p 'Better Auth URL (https://...): ' U; echo; umask 077; printf '%s' "$U" > "${STACK_ROOT:-.}/.secrets/better_auth_url.txt"; chmod 600 "${STACK_ROOT:-.}/.secrets/better_auth_url.txt"; unset U
```

Notes
- The VLLM key (`VLLM_API_KEY`) is read from env; you can export it in your shell or pass it with `--env VLLM_API_KEY=...` when starting `vllm`.
- We'll remove VLLM_API_KEY from env eventually.

### 3) Run the SIFs (no registry access required)

All services communicate over HTTP/TCP so the ports needs to be available.

#### DB (Postgres over TCP)

``` bash
apptainer run --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=postgres \
  --bind ${STACK_ROOT:-.}/pgdata:/var/lib/postgresql \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  $STACK_ROOT/postgres_18.sif
```

```
# Optional: verify your model path exists
ls -al "$STACK_ROOT/models/Qwen3-32B-FP8" || true
```

```
# Optional: ping postgres
curl -i http://127.0.0.1:5432/
```

VLLM (GPU, HTTP on :8000)
``` bash
apptainer run --cleanenv --nv \
  --bind $STACK_ROOT/models:/models:ro \
  $STACK_ROOT/vllm-openai_latest.sif \
  --model /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --api-key "$VLLM_API_KEY"
```

#### API

``` bash
apptainer run --cleanenv   --bind ${STACK_ROOT:-.}/.secrets/database_url.txt:/run/secrets/database_url:ro   --bind ${STACK_ROOT:-.}/.secrets/better_auth_secret.txt:/run/secrets/better_auth_secret:ro   --bind ${STACK_ROOT:-.}/.secrets/better_auth_url.txt:/run/secrets/better_auth_url:ro   --env DATABASE_URL_FILE=/run/secrets/database_url   --env BETTER_AUTH_SECRET_FILE=/run/secrets/better_auth_secret   --env BETTER_AUTH_URL_FILE=/run/secrets/better_auth_url   --env VITE_LLM_SERVER_URL=http://localhost:8000/v1   --env VITE_PORT=8181   --env VITE_SERVER_API=http://localhost:3001   --env API_SERVER_PORT=3001   $STACK_ROOT/api_server.sif
```
Replace 5432 in your `${STACK_ROOT:-.}/.secrets/database_url.txt` if you changed `POSTGRES_PORT`.

App (HTTP on :8080; talks to API over HTTP)
Note: The app image now uses an absolute CMD (`/app/app-server`), so Apptainer runs correctly regardless of your host working directory.
``` bash
apptainer -d run --cleanenv --env SERVER_HOST=localhost --env API_SERVER_PORT=3001 --env PROD_SERVER=8181 "$STACK_ROOT/app_server.sif"
```

Verification helpers
```
# Check env inside the SIF
apptainer exec --cleanenv $STACK_ROOT/postgres_18.sif env | grep POSTGRES_PASSWORD_FILE

# Check the secret is mounted
apptainer exec --cleanenv \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  $STACK_ROOT/postgres_18.sif \
  sh -lc 'ls -l /run/secrets && head -c 5 /run/secrets/db_password && echo'
```

### Clean reset and restore (PG18, Apptainer)

Use this flow to start fresh on the remote (remove old PG17 layout) and validate the full dump → push → restore path.

Prereqs
- Remote: `${STACK_ROOT}/.secrets/db_password.txt` exists with strict perms (0600)
- Local: Docker Postgres running for dumps (`docker compose --env-file .env.local up -d db`)
- Env: `SSH_ALIAS`, `STACK_ROOT`, `DB_NAME`, `DB_USER`, `DB_PASS`, `POSTGRES_PORT`

1) Reset on remote (remove legacy data layout)
```bash
# Remote: close any running instance of postgres
apptainer instance stop pg18 || true
# Remote: Safe backup then recreate clean dir
mv -f ${STACK_ROOT}/pgdata ${STACK_ROOT}/pgdata_pg18_bak_$(date +%Y%m%d_%H%M%S) || true; install -d -m 700 ${STACK_ROOT}/pgdata
# If perms block removal, force delete then recreate
# ssh $SSH_ALIAS 'chmod -R u+w ${STACK_ROOT}/pgdata || true; rm -rf ${STACK_ROOT}/pgdata || true; install -d -m 700 ${STACK_ROOT}/pgdata'
```

2) Start Postgres 18 (fresh cluster)
```bash
# Remote: start postgres in container
apptainer run --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=${DB_NAME:-postgres} \
  --bind ${STACK_ROOT:-.}/pgdata:/var/lib/postgresql \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  ${STACK_ROOT}/postgres_18.sif
# Remote: check that is working
apptainer exec --cleanenv ${STACK_ROOT}/postgres_18.sif pg_isready -h 127.0.0.1 -p 5432 -U postgres
```

3) Push dump to remote (no restore, validates end-to-end copy)
```bash
# Local: ensure DB container is up for dump
docker compose --env-file .env.local up -d db
# Local: creates dump and uploads to ${STACK_ROOT}/backups on remote
bun run db:remote:push
# Remote: verify file arrived
ls -l ${STACK_ROOT}/backups
```

4) Restore into the fresh PG18 (scripted)
```bash
export REMOTE_DATABASE_URL="postgresql://postgres:$(cat ${STACK_ROOT}/.secrets/db_password.txt)@localhost:5432/${DB_NAME:-postgres}"
bun scripts/dbPush.ts --force --restore
```

or

Manual restore alternative (this is what I used last)
```bash
# start the local database to copy from
docker compose up db
# the push
bun db:r:p
# set ssh alias
# Pick the uploaded dump name from backups/
ls -1 ${STACK_ROOT}/backups
# Restore using an ephemeral Postgres 18 container
apptainer exec --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=${DB_NAME:-postgres} \
  --bind ${STACK_ROOT:-.}/pgdata:/var/lib/postgresql \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  --bind ${STACK_ROOT:-.}/backups:/backups:ro \
  ${STACK_ROOT}/postgres_18.sif \
  pg_restore -h localhost -p 5432 -U postgres -d ${DB_NAME:-postgres} \
  --clean --if-exists --no-owner --no-privileges --single-transaction /backups/dump_local_postgres_20251028_102914.dump
```

Why this works
- Postgres 18 expects a major-version layout under `/var/lib/postgresql`; a fresh, empty `${STACK_ROOT}/pgdata` avoids the legacy `/data` structure that triggers the safety check.
- `db:r:p` verifies the local dump and remote upload path; the `--restore` run completes the cycle by loading into the fresh cluster.

### About UNIX sockets (only for DB seeding)

Some HPC clusters disallow container networking entirely. We no longer support running the app or API against Postgres over UNIX sockets. The only remaining socket-based flow is for database population/restore via the `dbPush` helper, which still supports remote UNIX sockets when needed.

Database push/restore helpers (dbPush)
```bash
# Common env
export SSH_ALIAS=<user@hpc-host>
export STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev

# TCP remote (db listens on 5432); restore to remote after pushing dump
export REMOTE_DATABASE_URL='postgresql://postgres:***@localhost:5432/postgres'
bun scripts/dbPush.ts --force --restore

# Optional UNIX socket remote (only if your HPC forbids networking for Postgres). Instance name and socket dir are configurable.
export REMOTE_DATABASE_URL='postgresql://postgres:***@/postgres?host=/srv/pgsocket'
export REMOTE_PG_INSTANCE=pg18
# optional override if your socket path differs
# export REMOTE_SOCKET_DIR=/srv/pgsocket
bun scripts/dbPush.ts --force --restore --remote-socket

# If the HPC bind policy blocks /backups, stream the dump into the instance
bun scripts/dbPush.ts --force --restore --remote-socket --stream
```

Database URL forms (for runtime)
- TCP: `postgresql://user:pass@host:port/db` (e.g., `postgresql://postgres:pw@localhost:5432/postgres`)
- For dbPush only, a UNIX socket DSN is supported: `postgresql://user:pass@/db?host=/path/to/socketdir`
  - The `dbPush` script reads `REMOTE_DATABASE_URL` and accepts `--remote-socket` to force socket mode. It honors `REMOTE_PG_INSTANCE` and `REMOTE_SOCKET_DIR`.

Notes
- Prefer HTTP/TCP everywhere (Postgres over TCP; API/App/vLLM over HTTP). Browsers cannot use sockets, and HTTP simplifies Apptainer/HPC setups.
- If the HPC bind policy blocks `/backups`, use the `--stream` option with `dbPush` to stream the dump into the instance.

## Troubleshooting
  - Recreate database volume
    - Stop and remove containers and the named volume: `docker compose down -v`
    - Start again with your env: `docker compose --env-file .env.local up db`
  - Create the DB manually (alternative): `docker exec -it $(docker ps --filter name=db --format '{{.ID}}') psql -U ${DB_USER:-postgres} -c "CREATE DATABASE ${DB_NAME:-appdb};"`
