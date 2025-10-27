# vLLM Multi-Node Model Loading Fix

## Issue

When running vLLM with Ray distributed backend across multiple nodes, vLLM fails with:

```
huggingface_hub.errors.HFValidationError: Repo id must be in the form 'repo_name' or 'namespace/repo_name': '/models/Qwen3-32B-FP8'
```

This occurs because vLLM tries to validate the local filesystem path as a HuggingFace repository ID before recognizing it as a local directory.

## Root Cause

1. **vLLM V1 Engine + Ray Backend**: The V1 engine with Ray distributed backend has stricter path validation
2. **Missing `--load-format` parameter**: Without explicit format specification, vLLM attempts HuggingFace validation first
3. **Ray Workers Lack Model Access**: Worker nodes need bind mounts to access model files on shared filesystem
4. **Environment Variables Not Fully Propagated**: Offline mode flags and cache paths need to be set on all Ray workers

## Changes Made

### 1. Added `--load-format auto` Parameter

**File**: `forska-stack.sbatch` line 669

```bash
--model /models/Qwen3-32B-FP8 \
  --load-format auto \
```

This explicitly tells vLLM to detect the format from local files rather than attempting HuggingFace download.

### 2. Bind Model Directory to Ray Workers

**File**: `forska-stack.sbatch` line 536

Added bind mount to Ray worker script:

```bash
--bind "${STACK_ROOT}/models:/models:ro" \
```

### 3. Bind Cache Directories to Workers

**File**: `forska-stack.sbatch` lines 537-538

```bash
--bind "${HF_HOME}:${HF_HOME}" \
--bind "${VLLM_CACHE_ROOT}:${VLLM_CACHE_ROOT}" \
```

### 4. Export Required Environment Variables

**File**: `forska-stack.sbatch` line 550

Added to worker srun export list:

```bash
HF_HOME=${HF_HOME},VLLM_CACHE_ROOT=${VLLM_CACHE_ROOT},STACK_ROOT=${STACK_ROOT}
```

### 5. Added Preflight Model Directory Checks

**File**: `forska-stack.sbatch` lines 619-645

Validates:
- Model directory exists
- Contains required `config.json`
- Warns about shared filesystem requirements for multi-node

## Requirements for Multi-Node vLLM

### Shared Filesystem

**CRITICAL**: The model directory MUST be on a shared filesystem accessible from all compute nodes:

```bash
# Check from head node
ls -la $STACK_ROOT/models/Qwen3-32B-FP8

# Verify from worker nodes (during job or via interactive allocation)
srun --nodes=2 --ntasks-per-node=1 ls -la $STACK_ROOT/models/Qwen3-32B-FP8
```

### Expected Model Structure

```
$STACK_ROOT/models/Qwen3-32B-FP8/
├── config.json              # Required
├── tokenizer_config.json    # Required
├── tokenizer.json           # Required (or equivalent)
├── model-*.safetensors      # Model weights
└── ...
```

### Offline Mode Requirements

Set before job submission or in `.bashrc`:

```bash
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
```

## Verification Steps

### 1. Check Model Directory

```bash
# On head node
ssh alvis2
cd $STACK_ROOT
ls -la models/Qwen3-32B-FP8/

# Should show config.json and model files
```

### 2. Test Multi-Node Access

```bash
# Request 2 nodes interactively
salloc -N 2 --gpus-per-node=A100:4 -t 0:10:00 -A NAISS2025-22-715

# Test access from all nodes
srun --nodes=2 --ntasks-per-node=1 cat $STACK_ROOT/models/Qwen3-32B-FP8/config.json
```

### 3. Submit Fixed Job

```bash
cd $STACK_ROOT
sbatch --export=ALL forska-stack.sbatch
```

### 4. Monitor Startup

```bash
# Watch logs
tail -f logs/<job_id>/vllm.log

# Check Ray cluster
tail -f logs/<job_id>/ray-head.log
tail -f logs/<job_id>/ray-worker-*.log
```

## Troubleshooting

### Still Getting "Invalid Repository ID" Error

1. **Verify filesystem type**:
   ```bash
   df -T $STACK_ROOT
   ```
   Should show network filesystem (NFS, Lustre, etc.)

2. **Check permissions**:
   ```bash
   # From all nodes
   srun -N 2 test -r $STACK_ROOT/models/Qwen3-32B-FP8/config.json && echo "OK" || echo "FAIL"
   ```

3. **Verify bind mounts in container**:
   ```bash
   # Add debug to worker script before exec:
   ls -la /models/Qwen3-32B-FP8/ || echo "Model dir not accessible in container"
   ```

### Ray Workers Not Starting

1. **Check Ray connectivity**:
   ```bash
   # In logs/<job_id>/ray-worker-*.log
   grep -i "error\|failed\|connection" logs/<job_id>/ray-worker-*.log
   ```

2. **Verify HEAD_IP resolution**:
   Check that HEAD_IP is an IPv4 address reachable from workers

3. **Port conflicts**:
   Review `logs/<job_id>/port-allocation.log`

### Model Loading Takes Forever

This is normal for large models on first load. For Qwen3-32B-FP8 across 8 GPUs, expect:
- Ray cluster init: 30-60s
- Model loading: 2-5 minutes
- Warmup/compilation: 1-2 minutes

Total startup: ~5-8 minutes

## Performance Notes

### Multi-Node Configuration

With 2 nodes × 4 GPUs:
- **TP_SIZE=8, DP_SIZE=1**: All 8 GPUs work on single request (maximum throughput per request)
- **TP_SIZE=4, DP_SIZE=2**: 2 independent 4-GPU shards (better for concurrent requests)

Override via export:
```bash
sbatch --export=ALL,TP_SIZE=4,DP_SIZE=2 forska-stack.sbatch
```

### Recommended Settings

For research workloads (sequential, high quality):
```bash
TP_SIZE=8, DP_SIZE=1, GPU_UTIL=0.90
```

For production workloads (concurrent users):
```bash
TP_SIZE=4, DP_SIZE=2, GPU_UTIL=0.85
```

## References

- vLLM Distributed Inference: https://docs.vllm.ai/en/latest/serving/distributed_serving.html
- Ray on HPC: https://docs.ray.io/en/latest/cluster/vms/user-guides/community/slurm.html
- Apptainer User Guide: https://apptainer.org/docs/user/main/

## Summary

The fix ensures:
1. vLLM recognizes local model paths via `--load-format auto`
2. All Ray workers can access model files via bind mounts
3. Offline mode is enforced across all processes
4. Cache directories are accessible for tokenizers
5. Preflight checks catch configuration errors early

After applying these changes, vLLM should successfully load the model from the shared filesystem across all nodes.

