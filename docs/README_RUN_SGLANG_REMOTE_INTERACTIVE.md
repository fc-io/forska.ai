# Run SGLang (Gateway + Worker) — HPC Interactive

This guide shows how to run the SGLang Model Gateway and a single Worker in an interactive session on an HPC cluster using Apptainer.

Prereqs
- Apptainer/Singularity available on the HPC node(s)
- A GPU node.
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

## 2) Pull the SGLang image (one‑time)

Stores a local `.sif` under `$STACK_ROOT` for offline‑friendly runs.

```bash
apptainer pull --arch amd64 "$STACK_ROOT/sglang_latest.sif" docker://docker.io/lmsysorg/sglang:latest
```

## 3) Allocate an interactive session

Examples (adjust to your cluster’s options). You need CPUs for the Gateway and at least one GPU for the Worker.

```bash
# Example: one node with 2 A100 GPUs for a few hours
salloc -A NAISS2025-22-715 -N1 --gres=gpu:A100fat:1 --time=1:00:00 --no-shell

# Start an interactive shell on the allocated node
srun --jobid=5243821 --overlap --pty bash -l
```

Tip: use tmux/zellij or two shells. Run the Gateway in one shell and the Worker in another (on the same node for simplest networking).

## 4) Start the Gateway (CPU)

Runs on port 30000 and responds to `GET /v1/models`.

```bash
apptainer exec --cleanenv \
  --env HF_HOME=/hf_cache \
  --bind $STACK_ROOT/hf_cache:/hf_cache:rw \
  "$STACK_ROOT/sglang_latest.sif" \
  python -m sglang.gateway \
    --host 0.0.0.0 --port 30000 \
    --allow-credentials --max-queue-size 256
```

Keep this running. In another shell on the same node:

## 5) Start a Worker (GPU)

Set where the Worker can reach the Gateway. If both run on the same node, use localhost.

```bash
export SGLANG_GATEWAY_URL=http://localhost:30000

# Optional: pin which GPUs this Worker sees
# export CUDA_VISIBLE_DEVICES=0,1

apptainer exec --cleanenv --nv \
  --env HF_HOME=/hf_cache \
  --bind $STACK_ROOT/hf_cache:/hf_cache:rw \
  --env SGLANG_CACHE_DIR=/sg_cache \
  --bind $STACK_ROOT/.cache/sglang:/sg_cache:rw \
  "$STACK_ROOT/sglang_latest.sif" \
  python -m sglang.launch \
    --model-path Qwen/Qwen2.5-7B-Instruct \
    --gateway ${SGLANG_GATEWAY_URL} \
    --tp-size 2 \
    --max-batch-size 32 \
    --cache-dir /sg_cache
```

Notes
- Use one Worker per model replica. For A100 40GB, prefer `--tp-size 2` (2 GPUs per Worker). For A100‑80G/H200, prefer `--tp-size 1`.
- Replace `Qwen/Qwen2.5-7B-Instruct` with your desired Hugging Face model ID (e.g., `meta-llama/Meta-Llama-3-8B-Instruct`). Set `HUGGINGFACE_HUB_TOKEN` if the model requires it.

## 6) Verify with curl

List models registered at the Gateway:

```bash
curl -sSf http://localhost:30000/v1/models | jq .
```

Send a simple chat completion (replace `<MODEL_ID>` with one returned by `/v1/models`):

```bash
curl -sSf http://localhost:30000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "<MODEL_ID>",
    "messages": [
      {"role": "user", "content": "Say hello in five words."}
    ],
    "temperature": 0.2
  }' | jq .
```

Expected: a JSON response with a `choices[0].message.content` string.

## 7) Multi‑node variant (optional)

You can run the Gateway on a CPU node and connect Workers from GPU nodes. Set `SGLANG_GATEWAY_URL=http://<gateway-host>:30000` on each Worker and ensure network reachability (host networking, firewalls, partitions).

## 8) Troubleshooting
- Check ports: `ss -ltnp | grep 30000`
- GPU visibility: `apptainer exec --nv "$STACK_ROOT/sglang_latest.sif" nvidia-smi`
- HF access: ensure `HF_HOME` is writable and `HUGGINGFACE_HUB_TOKEN` is set for gated models
- Logs: watch the Gateway shell for “worker registered”; the Worker logs should show loaded weights and GPU memory usage

## 9) Clean up
- Stop processes with Ctrl‑C in each shell, then `exit` to release the allocation.

## Quick reference
- Gateway (CPU): `python -m sglang.gateway --host 0.0.0.0 --port 30000`
- Worker (GPU): `python -m sglang.launch --model-path <HF_MODEL_ID> --gateway $SGLANG_GATEWAY_URL [--tp-size N]`
- Health: `curl -sf http://localhost:30000/v1/models`
