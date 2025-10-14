# forska.ai

Elysia (Bun) API server + Solid (Vite) client, using Drizzle ORM (Postgres) and Better Auth.

```
export STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev; mkdir -p $STACK_ROOT/{pgdata,models,hf_cache,logs} && echo $STACK_ROOT
export XDG_CACHE_HOME=$STACK_ROOT/.cache; export VLLM_CACHE_ROOT=$XDG_CACHE_HOME/vllm; export TORCHINDUCTOR_CACHE_DIR=$VLLM_CACHE_ROOT/torchinductor; export TRITON_CACHE_DIR=$VLLM_CACHE_ROOT/triton; export HF_HOME=$STACK_ROOT/hf_cache
```

```
ls -al $STACK_ROOT/models/Qwen3-32B-FP8
```

## Docker Compose

Two modes are available:

1) Default (bridge network)

- Start everything locally with inter-service DNS (`db`, `vllm`, `api-server`).
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

When running images via Apptainer with host networking, use localhost URLs to mirror the hostnet profile above.

Examples (adjust org/image:tag and env to your setup):

```
# VLLM (GPU)
apptainer run --nv --net --network=host \
  docker://vllm/vllm-openai:latest \
  vllm serve /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --api-key "$VLLM_API_KEY"

# Postgres (database)
apptainer run --net --network=host \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=appdb \
  --bind $STACK_ROOT/pgdata:/var/lib/postgresql/data \
  docker://docker.io/library/postgres:18-alpine

# API server
apptainer run --net --network=host \
  --env DATABASE_URL=postgresql://postgres:postgres@localhost:5432/appdb \
  --env VITE_LLM_SERVER_URL=http://localhost:8000/v1 \
  --env SERVER_PORT=3000 \
  docker://ghcr.io/ORG/api-server:TAG

# App server (static assets + proxy to API)
apptainer run --net --network=host \
  --env SERVER_HOST=localhost --env SERVER_PORT=3000 \
  --env PROD_SERVER=8080 \
  docker://ghcr.io/ORG/app-server:TAG
```

Tip: the `--profile hostnet` compose setup on Linux behaves like Apptainer’s host networking, so you can validate localhost-based URLs locally before deploying.

### Using a password file (secrets)

The official Postgres image supports `POSTGRES_PASSWORD_FILE`. You can bind‑mount a local secret into the container and point Postgres at it.

Prepare a secret file on the host (one line, the password), then restrict permissions:
```
mkdir -p "$HOME/.secrets" && echo 'yourStrongPassword' > "$HOME/.secrets/pg_password" && chmod 600 "$HOME/.secrets/pg_password"
```

Run Postgres with a secret file mounted read‑only:
```
apptainer run --net --network=host \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/pg_password \
  --env POSTGRES_DB=appdb \
  --bind $STACK_ROOT/pgdata:/var/lib/postgresql/data \
  --bind $HOME/.secrets/pg_password:/run/secrets/pg_password:ro \
  docker://docker.io/library/postgres:18
```

Verification helpers:
```
# Check env inside the image
apptainer exec docker://docker.io/library/postgres:18 env | grep POSTGRES_PASSWORD_FILE

# Check the secret is mounted
apptainer exec \
  --bind $HOME/.secrets/pg_password:/run/secrets/pg_password:ro \
  docker://docker.io/library/postgres:18 \
  sh -lc 'ls -l /run/secrets && head -c 5 /run/secrets/pg_password && echo'
```

### Pre-pull images (offline compute nodes)

If compute nodes cannot reach container registries, pre-pull images on a login/head node with network access and place the `.sif` files on a shared filesystem (e.g., `$STACK_ROOT/images`) visible to compute nodes.

Pull on a networked node
```
mkdir -p "$STACK_ROOT/images"

# Public registries
apptainer pull "$STACK_ROOT/images/postgres_18.sif" docker://docker.io/library/postgres:18
apptainer pull "$STACK_ROOT/images/vllm_openai_latest.sif" docker://vllm/vllm-openai:latest

# GHCR (login first if private)
apptainer registry login ghcr.io -u "$GHCR_USER" -p "$GHCR_TOKEN"
apptainer pull "$STACK_ROOT/images/api_server_${TAG}.sif" docker://ghcr.io/$GHCR_OWNER/api-server:$TAG
apptainer pull "$STACK_ROOT/images/app_server_${TAG}.sif" docker://ghcr.io/$GHCR_OWNER/app-server:$TAG
```

Run on compute nodes using the `.sif` files (no registry access required)
```
# DB (Postgres)
apptainer run --net --network=host \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/pg_password \
  --env POSTGRES_DB=appdb \
  --bind $STACK_ROOT/pgdata:/var/lib/postgresql/data \
  --bind $HOME/.secrets/pg_password:/run/secrets/pg_password:ro \
  $STACK_ROOT/images/postgres_18.sif

# VLLM (GPU)
apptainer run --nv --net --network=host \
  --bind $STACK_ROOT/models:/models:ro \
  $STACK_ROOT/images/vllm_openai_latest.sif \
  vllm serve /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --api-key "$VLLM_API_KEY"

# API
apptainer run --net --network=host \
  --env DATABASE_URL=postgresql://postgres:postgres@localhost:5432/appdb \
  --env VITE_LLM_SERVER_URL=http://localhost:8000/v1 \
  --env SERVER_PORT=3000 \
  $STACK_ROOT/images/api_server_${TAG}.sif

# App
apptainer run --net --network=host \
  --env SERVER_HOST=localhost --env SERVER_PORT=3000 \
  --env PROD_SERVER=8080 \
  $STACK_ROOT/images/app_server_${TAG}.sif
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

Host networking is a runtime setting; you don’t need a special build. Build the same images and run them with host networking (Compose hostnet profile or Apptainer `--network=host`). Below are two ways to build and push to GitHub Container Registry (ghcr.io).

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

Option A — Build via Compose (uses hostnet service configs)
```
# Build the hostnet variants (Linux only)
docker compose --profile hostnet build api-server-hostnet app-server-hostnet

# Push directly with Compose (requires GHCR_OWNER and TAG)
docker compose --profile hostnet push api-server-hostnet app-server-hostnet
```

Option B — Plain Docker builds

API server
```
docker build -f Dockerfile.api -t ghcr.io/$GHCR_OWNER/api-server:$TAG .
docker push ghcr.io/$GHCR_OWNER/api-server:$TAG
```

App server (requires build args used by Vite build)
```
docker build -f Dockerfile.app \
  --build-arg DATABASE_URL=postgresql://postgres:postgres@localhost:5432/appdb \
  --build-arg BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET \
  --build-arg BETTER_AUTH_URL=http://localhost:3000 \
  --build-arg VITE_PORT=8080 \
  --build-arg SERVER_PORT=3000 \
  --build-arg RUN_SERVER_JUDGING=false \
  --build-arg VITE_LLM_SERVER_URL=http://localhost:8000/v1 \
  --build-arg VITE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/appdb \
  --build-arg VITE_SERVER_API=http://localhost:3000 \
  -t ghcr.io/$GHCR_OWNER/app-server:$TAG .

docker push ghcr.io/$GHCR_OWNER/app-server:$TAG
```

Pull/run with Apptainer
```
# DB (Postgres)
apptainer run --net --network=host \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=appdb \
  --bind $STACK_ROOT/pgdata:/var/lib/postgresql/data \
  docker://docker.io/library/postgres:18

# VLLM (GPU)
apptainer run --nv --net --network=host \
  --bind $STACK_ROOT/models:/models:ro \
  docker://vllm/vllm-openai:latest \
  vllm serve /models/Qwen3-32B-FP8 \
    --host 0.0.0.0 --port 8000 \
    --tensor-parallel-size ${TP_SIZE:-1} \
    --gpu-memory-utilization ${VLLM_GPU_UTIL:-0.90} \
    --api-key "$VLLM_API_KEY"

# API
apptainer run --net --network=host \
  --env DATABASE_URL=postgresql://postgres:postgres@localhost:5432/appdb \
  --env VITE_LLM_SERVER_URL=http://localhost:8000/v1 \
  --env SERVER_PORT=3000 \
  docker://ghcr.io/$GHCR_OWNER/api-server:$TAG

# App
apptainer run --net --network=host \
  --env SERVER_HOST=localhost --env SERVER_PORT=3000 \
  --env PROD_SERVER=8080 \
  docker://ghcr.io/$GHCR_OWNER/app-server:$TAG
```

Notes
- The same image works for both bridge and host networking; the difference is in how you run it.
- The app build reads env at build time (Vite). Ensure the build-arg values match the runtime endpoints you intend to use.
- If you prefer, you can source your `.env` and pass values in `--build-arg` from that file.
