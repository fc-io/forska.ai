# Quick Fix: vLLM "Invalid Repository ID" Error

## Error Signature

```
huggingface_hub.errors.HFValidationError: Repo id must be in the form 'repo_name' or 'namespace/repo_name': '/models/Qwen3-32B-FP8'
```

## Quick Diagnosis

```bash
# 1. Check if model exists on ALL nodes
srun -N <num_nodes> ls -la $STACK_ROOT/models/Qwen3-32B-FP8/config.json

# 2. Check filesystem type (must be shared: NFS/Lustre/etc)
df -T $STACK_ROOT

# 3. Verify offline mode is set
echo $HF_HUB_OFFLINE $TRANSFORMERS_OFFLINE
# Should show: 1 1
```

## Quick Fix Checklist

- [ ] Add `--load-format auto` to vLLM command
- [ ] Bind model dir to Ray workers: `--bind "$STACK_ROOT/models:/models:ro"`
- [ ] Bind cache dirs to workers: `--bind "$HF_HOME:$HF_HOME"`
- [ ] Export variables to workers: `HF_HOME`, `VLLM_CACHE_ROOT`, `STACK_ROOT`
- [ ] Set offline mode: `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`
- [ ] Model on shared filesystem accessible from all nodes

## Files Changed

- `forska-stack.sbatch`: Lines 536-538 (worker binds), line 550 (exports), line 669 (--load-format)

## Test Before Submitting

```bash
# Verify model accessibility from 2 nodes
salloc -N 2 --gpus-per-node=A100:4 -t 0:05:00 -A <account>
srun -N 2 cat $STACK_ROOT/models/Qwen3-32B-FP8/config.json
exit
```

## Submit Fixed Job

```bash
sbatch --export=ALL forska-stack.sbatch
```

## Monitor

```bash
# Watch vLLM startup
tail -f logs/<job_id>/vllm.log

# Should see:
# "Loading model from scratch..."
# "Using model weights format..."
# (NOT: "snapshot_download" or "HFValidationError")
```

## If Still Failing

1. Check `logs/<job_id>/ray-worker-*.log` for bind mount errors
2. Ensure `$STACK_ROOT` is defined in worker environment
3. Verify container has read access: `test -r /models/...`
4. Check Ray dashboard for worker status: `http://<head_ip>:8265`

## Expected Startup Time

- Ray cluster: ~30-60s
- Model load: ~2-5 min (32B model, 8 GPUs)
- Total: ~5-8 min until "vLLM is up"

## Success Indicators

```bash
# In vllm.log:
grep "Starting to load model" logs/<job_id>/vllm.log
grep "Loaded model" logs/<job_id>/vllm.log

# Health check:
curl -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models
```

