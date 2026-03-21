# Run Remote Inference

Goal: use HPC only for SGLang inference. Do not run Postgres, API, or app on Alvis/MN5.

## Alvis Quick Start

```bash
# Local machine: build and push the SGLang image when needed
bun run build:docker:sglang

# Local machine: sync that image to Alvis
bun run alvis:sglang:pull

# Local machine: launch one of the presets and keep the terminal open
bun run alvis:launch:a100:fat
bun run alvis:launch:a100:4

# Test the tunnel from another terminal
curl http://localhost:30001/v1/models
```

Optional local app flow

```bash
# Local API server using the Alvis tunnel plus launcher-discovered runtime metadata
bun run alvis:dev:server

# Local app
bun run dev:app
```

Do not copy worker URLs or topology into `.env.local`. Those are short-lived launcher/runtime values.

Use `--force` if you want a fresh Slurm job instead of reusing an existing one.

## What Runs Where

- HPC: `sglang_latest.sif` and the model weights only
- Local machine: the SSH tunnel, optional local API dev server, optional local app
- Not used on HPC for this flow: `postgres_18.sif`, `api_server.sif`, `app_server.sif`, `db_password.txt`, `database_url.txt`

## Alvis Setup

```bash
export STACK_ROOT=/mimer/NOBACKUP/groups/clin-agent-bench/dev
mkdir -p "$STACK_ROOT"/{hf_cache,logs,.cache,.apptainer/cache,tmp,.secrets}

export XDG_CACHE_HOME=$STACK_ROOT/.cache
export HF_HOME=$STACK_ROOT/hf_cache
export SGLANG_CACHE_DIR=$STACK_ROOT/.cache/sglang
export APPTAINER_TMPDIR=$STACK_ROOT/tmp
export TMPDIR=$APPTAINER_TMPDIR
export APPTAINER_CACHEDIR=$STACK_ROOT/.apptainer/cache
export GHCR_OWNER=fc-io
export GHCR_USER=fc-io
```

Only `sglang_latest.sif` is required for the Alvis launch flow.

Optional for gated Hugging Face models:

```bash
export HUGGINGFACE_HUB_TOKEN=xxxxxxxx
printf '%s' "$HUGGINGFACE_HUB_TOKEN" > "$STACK_ROOT/.secrets/hf_token.txt"
chmod 600 "$STACK_ROOT/.secrets/hf_token.txt"
```

## Build + Pull the SGLang Image

Use GHCR for clusters that can pull from registries.

```bash
# Local machine
bun run build:docker:sglang

# Local machine
bun run alvis:sglang:pull
```

The pull helper sshes to `alvis2`, stores a versioned `sglang_<tag>.sif`, and repoints `sglang_latest.sif` to it.

Fallback manual pull on Alvis:

```bash
apptainer registry login --username "$GHCR_USER" oras://ghcr.io
apptainer pull --arch amd64 "$STACK_ROOT/sglang_latest.sif" docker://ghcr.io/$GHCR_OWNER/sglang-server:$TAG
```

The custom `sglang-server` image is needed because upstream `lmsysorg/sglang:*` still does not recognize `Qwen/Qwen3.5-35B-A3B`.

## Alvis Launch Commands

Recommended presets:

```bash
# 1 node, 2x A100fat, one shared SGLang instance
bun run alvis:launch:a100:fat

# 1 node, 4x non-fat A100, one shared SGLang instance
bun run alvis:launch:a100:4
```

Useful helpers:

```bash
bun run alvis:status
bun run alvis:smi
bun run alvis:sbatch:push
```

The launch script:

- uploads `forska-alvis.sbatch`
- reuses a matching pending/running job when possible
- waits for the startup config block in the job log
- opens local SSH tunnels to the remote worker URLs
- keeps the tunnel alive until you press `Ctrl+C`

`Ctrl+C` in the launch terminal closes the tunnels and cancels the Slurm job.

## Manual sbatch Examples

```bash
# Default preset from the sbatch file
sbatch forska-alvis.sbatch

# Fresh launcher submission without reuse
bun run alvis:launch:a100:fat -- --force

# 1 node, 4x A100
bun run alvis:launch:a100:4 -- --force

# 1 node, 1x A100fat
sbatch --nodes=1 --gpus-per-node=A100fat:1 --export=ALL,TP_SIZE=1,DP_SIZE=1 forska-alvis.sbatch

# One worker per GPU instead of one shared instance
sbatch --export=ALL,SGLANG_ONE_WORKER_PER_GPU=1 forska-alvis.sbatch
```

Default Alvis sbatch runtime metadata:

- nodes: `1`
- gpus per node: `A100fat:2`
- model: `Qwen/Qwen3.5-35B-A3B`
- one worker per GPU: `0`
- TP size: `2`
- DP size: `1`

Models download directly from Hugging Face into `$HF_HOME` on first use.

## After Launch

The launcher exposes local worker URLs like `http://localhost:30001`.

Basic checks:

```bash
curl http://localhost:30001/v1/models
curl http://localhost:30001/get_model_info
```

OpenAI-compatible example:

```bash
curl http://localhost:30001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen/Qwen3.5-35B-A3B",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

Optional local app flow:

- `bun run alvis:dev:server` starts the local API server using the Alvis tunnel plus runtime metadata from the job log
- configure the provider/model in Forska at `/admin/models` to point at the local tunnel/runtime
- `bun run dev:app` starts the local app against that local API server

## Related Docs

- `README.md`
- `docs/README_RUN_SGLANG_REMOTE_INTERACTIVE.md`
- `docs/README_MN5_INFERENCE.md`
