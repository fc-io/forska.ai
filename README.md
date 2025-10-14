# forska.ai

This is a really deep, deep research "agent" It's actively developed, it's going to be a lot of changes.
You can run it yourself if you have the chops. There will be a hosted version eventually.

It uses Elysia/Bun for the API server. Solid.js/Tanstack/Vite on the client. Uses Drizzle ORM with Postgres and Better Auth. It then hooks up to open ai compatible apis – vllm or something, to analyze data (mainly research papers).

## Quick Start (Local production build)

Prereqs
- Bun installed
- Docker (for local Postgres) and a GPU if you plan to run VLLM locally

Steps
1) Install dependencies
```
bun install
```

2) Start Postgres (Compose, bridge network)
```
docker compose up db
```

3) Start API and App in watch mode
```
bun run dev:server
bun run dev:app
```

Default endpoints
- App: http://localhost:8080
- API: http://localhost:3000
- Postgres: localhost:5432

If you need the GPU-backed LLM locally, also start the `vllm` service via Compose (see below).

## Docker Compose

Two modes are available:

1) Default (bridge network)
- Start everything locally with inter-service DNS (`db`, `vllm`, `api-server`, `app-server`).
- Command: `docker compose up`
- Endpoints:
  - App: http://localhost:8080
  - API: http://localhost:3000
  - VLLM: http://localhost:8000
  - Postgres: localhost:5432

2) Host networking (Linux only; mirrors Apptainer/Singularity)
- Uses `network_mode: host` and localhost URLs inside containers.
- Command: `docker compose --profile hostnet up`
- Notes:
  - Requires Linux (Docker Desktop macOS/Windows does not support host networking for compose).
  - Ensure ports 5432/8000/3000/8080 are free on the host.
  - Services expect localhost endpoints:
    - DB: `postgresql://postgres:postgres@localhost:5432/appdb`
    - VLLM: `http://localhost:8000/v1`
    - API: `http://localhost:3000`
    - App: `http://localhost:8080`

## HPC / Apptainer (Singularity)

On clusters and airgapped compute nodes, pre-pull images to SIF files on a shared filesystem and run with host networking (`--net --network=host`). This mirrors the Compose hostnet profile and uses localhost URLs inside containers.

Recommended shared paths and caches
```
export STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev; \
  mkdir -p $STACK_ROOT/{pgdata,models,hf_cache,logs,images,.cache} && echo $STACK_ROOT
export XDG_CACHE_HOME=$STACK_ROOT/.cache; \
  export VLLM_CACHE_ROOT=$XDG_CACHE_HOME/vllm; \
  export TORCHINDUCTOR_CACHE_DIR=$VLLM_CACHE_ROOT/torchinductor; \
  export TRITON_CACHE_DIR=$VLLM_CACHE_ROOT/triton; \
  export HF_HOME=$STACK_ROOT/hf_cache

# Optional: verify your model path exists
ls -al "$STACK_ROOT/models/Qwen3-32B-FP8" || true
```

### 1) Pre-pull images (offline-friendly)

If compute nodes cannot reach container registries, pull on a login/head node with network access and place the `.sif` files under `$STACK_ROOT/images`.

```
mkdir -p "$STACK_ROOT/images"

# Public registries (explicit amd64)
apptainer pull --arch amd64 "$STACK_ROOT/images/postgres_18.sif" docker://docker.io/library/postgres:18
apptainer pull --arch amd64 "$STACK_ROOT/images/vllm_openai_latest.sif" docker://vllm/vllm-openai:latest

# GHCR (login first if private)
apptainer registry login ghcr.io -u "$GHCR_USER"
apptainer pull --arch amd64 "$STACK_ROOT/images/api_server_${TAG}.sif" docker://ghcr.io/$GHCR_OWNER/api-server:$TAG
apptainer pull --arch amd64 "$STACK_ROOT/images/app_server_${TAG}.sif" docker://ghcr.io/$GHCR_OWNER/app-server:$TAG
```

Tip: the `--profile hostnet` compose setup on Linux behaves like Apptainer’s host networking, so you can validate localhost-based URLs locally before deploying.

### 2) Provide secrets (Postgres password file)

The official Postgres image supports `POSTGRES_PASSWORD_FILE`. Create a one-line secret and restrict permissions:
```
mkdir -p "$HOME/.secrets" && echo 'yourStrongPassword' > "$HOME/.secrets/pg_password" && chmod 600 "$HOME/.secrets/pg_password"
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
  --env DATABASE_URL=postgresql://postgres:postgres@localhost:5432/appdb \
  --env VITE_LLM_SERVER_URL=http://localhost:8000/v1 \
  --env SERVER_PORT=3000 \
  $STACK_ROOT/images/api_server_${TAG}.sif
```

App
```
apptainer run --net --network=host \
  --env SERVER_HOST=localhost --env SERVER_PORT=3000 \
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
