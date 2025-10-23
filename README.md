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
  --env POSTGRES_DB=postgres \
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

### Apptainer without networking (UNIX sockets)

Some HPC clusters disallow container networking entirely. In that case, run Postgres over a shared UNIX domain socket and bind that directory into every Apptainer instance that needs DB access.

#### Server (Postgres)

``` bash
# 0) Stop any old instance (safe to ignore errors)
apptainer instance stop pg18 || true
```

``` bash
# 1) Prepare dirs (data, secrets, shared socket)
install -d -m 700 "$STACK_ROOT/.secrets" "$STACK_ROOT/pgdata"
install -d -m 1777 "$STACK_ROOT/pgsocket" # world-writable sticky dir for sockets

# 2) Start the instance (no networking flags needed)
apptainer instance start \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_DB=postgres \
  --bind "$STACK_ROOT/pgdata:/var/lib/postgresql/data" \
  --bind "$STACK_ROOT/.secrets/db_password.txt:/run/secrets/db_password:ro" \
  --bind "$STACK_ROOT/backups:/backups:ro" \
  --bind "$STACK_ROOT/pgsocket:/srv/pgsocket" \
  "$STACK_ROOT/postgres_18.sif" pg18

# 3) Initialize cluster (first run only) with password auth on local sockets
apptainer exec --cleanenv instance://pg18 bash --noprofile --norc -lc \
  'initdb -D /var/lib/postgresql/data -U postgres -A scram-sha-256 --pwfile=/run/secrets/db_password'
```

``` bash
# 4) Start Postgres, listening ONLY on the UNIX socket in the shared dir
apptainer exec --cleanenv instance://pg18 bash --noprofile --norc -lc \
  'pg_ctl -D /var/lib/postgresql/data \
    -l /var/lib/postgresql/data/server.log \
    -o "-c unix_socket_directories=/srv/pgsocket -c unix_socket_permissions=0777 -c listen_addresses='' -c dynamic_shared_memory_type=mmap" \
    -w start'
```

``` bash
# 5) Wait for readiness over the socket
apptainer exec --cleanenv instance://pg18 bash --noprofile --norc -lc \
  'for i in {1..120}; do PGHOST=/srv/pgsocket pg_isready -U postgres >/dev/null 2>&1 && { echo "Postgres is ready."; exit 0; }; sleep 0.5; done; tail -n 200 /var/lib/postgresql/data/server.log; exit 1'

# 6) Optional: restore latest dump from bound backups dir
apptainer exec --cleanenv instance://pg18 bash --noprofile --norc -lc \
  'f=$(ls -1t /backups/dump_local_postgres_*.dump | head -n1); echo "Restoring $f"; PGHOST=/srv/pgsocket pg_restore -U postgres -d postgres --clean --if-exists --no-owner --verbose -j $(nproc) "$f"'

# 7) Sanity check
apptainer exec --cleanenv instance://pg18 bash --noprofile --norc -lc \
  'PGHOST=/srv/pgsocket psql -U postgres -d postgres -c "SELECT current_database() AS db, now() AS ts;"'
```

Clients (any Apptainer instance that needs DB access)

```bash
# Optional connectivity check (helpful on first setup or when debugging):
# Bind the same socket dir and point clients to it with PGHOST or a socket DSN
apptainer exec \
  --bind "$STACK_ROOT/pgsocket:/srv/pgsocket" \
  "$STACK_ROOT/postgres_18.sif" \
  bash -lc 'PGHOST=/srv/pgsocket psql -U postgres -d postgres -c "select 1"'
```

Database URL over sockets (for API / Node clients)
- Env vars: `PGHOST=/srv/pgsocket`, `PGUSER=postgres`, `PGDATABASE=postgres` (password via your secret file).
- DSN form: `postgresql://postgres@/postgres?host=/srv/pgsocket` (password can be embedded or read via `DATABASE_URL_FILE`).

Note on sockets vs TCP
- Only the database connection uses UNIX domain sockets here.
- The API and App still expose HTTP on TCP ports so browsers can reach them; browsers cannot speak UNIX sockets. If you run the App locally, it should remain on host networking or a reachable TCP port.

Example API run (socket DSN)
```bash
# Write a socket-based DSN to the secret file
umask 077; printf '%s\n' "postgresql://postgres@/postgres?host=/srv/pgsocket" > "$STACK_ROOT/.secrets/database_url.txt"

apptainer run \
  --bind "$STACK_ROOT/pgsocket:/srv/pgsocket" \
  --bind "$STACK_ROOT/.secrets/database_url.txt:/run/secrets/database_url:ro" \
  --env DATABASE_URL_FILE=/run/secrets/database_url \
  --env VITE_LLM_SERVER_URL=http://localhost:8000/v1 \
  --env API_SERVER_PORT=3000 \
  "$STACK_ROOT/api_server.sif"
```

Start App (host network)
```bash
apptainer run --net --network=host \
  --env SERVER_HOST=localhost \
  --env API_SERVER_PORT=3000 \
  --env PROD_SERVER=8080 \
  "$STACK_ROOT/app_server.sif"
```

Start VLLM (host network + GPU)
```bash
apptainer run --nv --net --network=host \
  --bind "$STACK_ROOT/models:/models:ro" \
  "$STACK_ROOT/vllm_openai_latest.sif" \
  vllm serve /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --api-key "$VLLM_API_KEY"
```

Database push/restore helpers (dbPush)
```bash
# Common env
export SSH_ALIAS=<user@hpc-host>
export STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev

# TCP remote (db listens on 5432); restore to remote after pushing dump
export REMOTE_DATABASE_URL='postgresql://postgres:***@localhost:5432/postgres'
bun scripts/dbPush.ts --force --restore

# UNIX socket remote (no networking). Instance name and socket dir are configurable.
export REMOTE_DATABASE_URL='postgresql://postgres:***@/postgres?host=/srv/pgsocket'
export REMOTE_PG_INSTANCE=pg18
# optional override if your socket path differs
# export REMOTE_SOCKET_DIR=/srv/pgsocket
bun scripts/dbPush.ts --force --restore --remote-socket

# If the HPC bind policy blocks /backups, stream the dump into the instance
bun scripts/dbPush.ts --force --restore --remote-socket --stream
```

Database URL forms
- TCP: `postgresql://user:pass@host:port/db` (e.g., `postgresql://postgres:pw@localhost:5432/postgres`)
- UNIX socket: `postgresql://user:pass@/db?host=/path/to/socketdir` (e.g., `postgresql://postgres:pw@/postgres?host=/srv/pgsocket`)
- The `dbPush` script reads `REMOTE_DATABASE_URL` and also accepts `--remote-socket` to force socket mode. It honors `REMOTE_PG_INSTANCE` and `REMOTE_SOCKET_DIR`.

Notes and pitfalls
- Ensure the socket dir is writable and shared: use `0777` on the directory (sticky bit optional) so processes with different UIDs can create/connect.
- Keep the socket path short; Linux’s UNIX socket path limit is ~108 bytes. `"$STACK_ROOT/pgsocket"` is usually fine; avoid very deep paths.
- `listen_addresses=''` disables TCP entirely; all clients must use the UNIX socket.
- Services that do not support UNIX sockets cannot communicate without networking. For those, run them in the same instance or on the host.
- If the HPC bind policy blocks `/backups`, stream the dump into the instance and restore from a file under the data dir instead.

## Troubleshooting
  - Recreate database volume
    - Stop and remove containers and the named volume: `docker compose down -v`
    - Start again with your env: `docker compose --env-file .env.local up db`
  - Create the DB manually (alternative): `docker exec -it $(docker ps --filter name=db --format '{{.ID}}') psql -U ${DB_USER:-postgres} -c "CREATE DATABASE ${DB_NAME:-appdb};"`
