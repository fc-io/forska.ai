# Run SGLang Server — HPC Interactive

This guide shows how to run SGLang in an interactive session on an HPC cluster using Apptainer.

**Note:** SGLang v0.5.4 uses a unified `launch_server` command (no separate Gateway/Worker processes).

Prereqs

- Apptainer/Singularity available on the HPC node(s)
- A GPU node
- Shared cache directories (recommended) on a fast filesystem
- Hugging Face access (set `HUGGINGFACE_HUB_TOKEN` if the model is gated)

## 1) Prepare shared paths and env

Recommended shared paths and caches (adapt paths for your site):

```bash
export STACK_ROOT=/path/to/shared/dev
mkdir -p "$STACK_ROOT"/{hf_cache,logs,.cache,.apptainer/cache,tmp}

export XDG_CACHE_HOME=$STACK_ROOT/.cache
export HF_HOME=$STACK_ROOT/hf_cache
export SGLANG_CACHE_DIR=$STACK_ROOT/.cache/sglang
```

Optional (for gated models):

```bash
export HUGGINGFACE_HUB_TOKEN=xxxxxxxx
```

## 2) Pull the SGLang image (one-time)

Stores a local `.sif` under `$STACK_ROOT`. Model weights download into `$STACK_ROOT/hf_cache` on first use.

Build and push the custom image first with `bun run build:docker:sglang` if you do not already have a `TAG`.

```bash
apptainer registry login --username "$GHCR_USER" oras://ghcr.io
apptainer pull --arch amd64 "$STACK_ROOT/sglang_latest.sif" docker://ghcr.io/$GHCR_OWNER/sglang-server:$TAG
```

## 3) Allocate an interactive session

Examples (adjust to your cluster's options):

**For the default Alvis shape (2x A100fat on one node) — use 2 GPUs:**

```bash
salloc -A NAISS2025-22-715 -N1 --gres=gpu:A100fat:2 --time=7:00:00 --no-shell
```

**For A100-40G — use 2 GPUs:**

```bash
salloc -A NAISS2025-22-715 -N1 --gres=gpu:A100:2 --time=1:00:00 --no-shell
```

Start an interactive shell on the allocated node:

```bash
srun --jobid=<YOUR_JOB_ID> --overlap --pty bash -l
```

## 4) Start the SGLang server

**For the default Alvis shape (2x A100fat on one node) — use tensor-parallel-size 2:**

```bash
apptainer exec --cleanenv --nv \
  --env HF_HOME=/hf_cache \
  --bind $STACK_ROOT/hf_cache:/hf_cache:rw \
  --env SGLANG_CACHE_DIR=/sg_cache \
  --bind $STACK_ROOT/.cache/sglang:/sg_cache:rw \
  "$STACK_ROOT/sglang_latest.sif" \
  python -m sglang.launch_server \
    --model-path Qwen/Qwen3.5-35B-A3B \
    --host 0.0.0.0 --port 30000 \
    --tensor-parallel-size 2 \
    --trust-remote-code \
    --max-running-requests 64 \
    --mem-fraction-static 0.92 \
    --schedule-policy lpm \
    --enable-metrics \
    --download-dir /hf_cache
```

**For A100-40G — use tensor-parallel-size 2:**

```bash
apptainer exec --cleanenv --nv \
  --env HF_HOME=/hf_cache \
  --bind $STACK_ROOT/hf_cache:/hf_cache:rw \
  --env SGLANG_CACHE_DIR=/sg_cache \
  --bind $STACK_ROOT/.cache/sglang:/sg_cache:rw \
  "$STACK_ROOT/sglang_latest.sif" \
  python -m sglang.launch_server \
    --model-path Qwen/Qwen3.5-35B-A3B \
    --host 0.0.0.0 --port 30000 \
    --tensor-parallel-size 2 \
    --trust-remote-code \
    --max-running-requests 64 \
    --mem-fraction-static 0.92 \
    --schedule-policy lpm \
    --enable-metrics \
    --download-dir /hf_cache
```

**Parameters explained:**

- `--tensor-parallel-size`: Number of GPUs to split the model across (the default Alvis setup uses 2 GPUs with `--tensor-parallel-size 2`)
- `--max-running-requests`: Maximum concurrent requests (64 tuned for uniform 2-3K token prompts)
- `--mem-fraction-static`: GPU memory fraction for KV cache (0.92 uses ~75GB on A100-80G)
- `--schedule-policy`: Scheduling algorithm (lpm = longest-prompt-first for better batching)
- `--download-dir`: Where to cache model weights (must be container path, not host path)

**Notes:**

- Replace `Qwen/Qwen3.5-35B-A3B` with your desired Hugging Face model ID
- Set `HUGGINGFACE_HUB_TOKEN` environment variable if the model requires authentication
- First start is slower if the model is not already cached under `$STACK_ROOT/hf_cache`
- For multi-node setups, use `--data-parallel-size`, `--nnodes`, `--node-rank`, and `--dist-init-addr`

## 5) Verify with curl

List available models:

```bash
curl -sSf http://localhost:30000/v1/models | jq .
```

Send a chat completion request:

```bash
curl -sSf http://localhost:30000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen/Qwen3.5-35B-A3B",
    "messages": [
      {"role": "user", "content": "Say hello in five words."}
    ],
    "temperature": 0.2
  }' | jq .
```

Expected: a JSON response with `choices[0].message.content` containing the model's reply.

## 6) Troubleshooting

- **Check ports:** `ss -ltnp | grep 30000`
- **GPU visibility:** `apptainer exec --nv "$STACK_ROOT/sglang_latest.sif" nvidia-smi`
- **HF access:** Ensure `HF_HOME` is writable and `HUGGINGFACE_HUB_TOKEN` is set for gated models
- **Tensor parallel mismatch:** Ensure allocated GPUs match `--tensor-parallel-size` (1 GPU = TP 1, 2 GPUs = TP 2)
- **Module not found:** Verify SGLang version with `apptainer exec "$STACK_ROOT/sglang_latest.sif" python -c "import sglang; print(sglang.__version__)"`

## 7) Clean up

Stop the server with Ctrl‑C, then `exit` to release the allocation.

## Quick reference

- **Server:** `python -m sglang.launch_server --model-path <HF_MODEL_ID> --host 0.0.0.0 --port 30000 --tensor-parallel-size <N> --max-running-requests 64 --mem-fraction-static 0.92 --schedule-policy lpm --enable-metrics`
- **Health:** `curl -sf http://localhost:30000/v1/models`
- **Default Alvis shape:** Use `--tensor-parallel-size 2` with 2x A100fat on one node
- **1-GPU A100-80G/H200 override:** Use `--tensor-parallel-size 1`
- **Performance tuning:** Increase `--max-running-requests` for more concurrency; adjust `--mem-fraction-static` (0.85-0.95) based on memory headroom
