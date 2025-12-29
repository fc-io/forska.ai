# MareNostrum 5 (MN5) - Manual Inference Launch Guide

**Purpose**: Step-by-step manual instructions for launching SGLang inference on MN5, replicating what `bun run mn5:launch` does automatically. Useful for **debugging** and **understanding** the process.

## Prerequisites

Before starting, ensure:

1. **SSH keys are loaded**:
   ```bash
   ssh-add -l  # Check if keys are loaded
   ssh-add ~/.ssh/id_ed25519_bsc  # Add if needed
   ```

2. **SSH config is set up** with hosts `tlog`, `glog`, and `alog` (see [README_MN5_INFERENCE.md](./README_MN5_INFERENCE.md#ssh-config-example))

3. **Model and container have been transferred** (first-time setup):
   ```bash
   bun run mn5:transfer
   ```

---

## Step 1: Deploy the sbatch Script

Copy the Slurm batch script from your local machine to MN5 via the **transfer login node** (`tlog`).

```bash
# From your project root directory
scp forska-mn5-sglang.sbatch tlog:/gpfs/projects/ehpc482/dev/
```

**What this does:**
- Uploads `forska-mn5-sglang.sbatch` to the MN5 development directory
- Uses the transfer node (`transfer4.bsc.es`) which is optimized for file transfers

**Expected output:**
```
forska-mn5-sglang.sbatch         100% 7041    XX.XKB/s   00:00
```

---

## Step 2: Submit the Job to Slurm

Connect to the **general login node** (`glog`) and submit the batch job.

### Standard submission (MiMo-V2-Flash, 2 nodes, 8 GPUs):

```bash
ssh glog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL forska-mn5-sglang.sbatch"
```

### Submission with a different model:

```bash
ssh glog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL,SGLANG_MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507 forska-mn5-sglang.sbatch"
```

**What this does:**
- Submits the job to the ACC queue (`--qos=acc_ehpc`)
- Requests 2 nodes with 4 GPUs each (8 H100s total for MiMo-V2-Flash)
- Job will run for up to 8 hours

**Expected output:**
```
Submitted batch job 12345678
```

**Save the job ID!** You'll need it: `12345678`

---

## Step 3: Wait for Job to Start Running

Poll the Slurm queue until your job transitions from `PENDING` to `RUNNING`.

### Check job status:

```bash
ssh glog "squeue -j 12345678"  # Replace with your job ID
```

Or, with more detail:

```bash
ssh glog "squeue -u \$USER -o '%i %j %T %M %N %R'"
```

| Column | Meaning |
|--------|---------|
| `%i` | Job ID |
| `%j` | Job name |
| `%T` | State (PENDING/RUNNING/etc) |
| `%M` | Time running |
| `%N` | Node list |
| `%R` | Reason (if pending) |

### Repeatedly check until RUNNING:

```bash
# Wait and check (repeat until state is RUNNING)
ssh glog "squeue -j 12345678 -h -o '%T %N'"
```

**Expected output when pending:**
```
PENDING (Resources)
```

**Expected output when running:**
```
RUNNING acc020,acc021
```

**Extract the head node** (first node in the list):
- If output is `RUNNING acc020,acc021`, the head node is `acc020`
- Save this node name for the next steps

---

## Step 4: Wait for SGLang to Be Ready

SGLang needs time to load the model weights. **Large models like MiMo-V2-Flash (313GB) take 15-20 minutes.**

### Option A: Check via API (from ACC login)

Test if the API is responding from the `alog` node:

```bash
# Replace 'acc020' with your actual head node
ssh alog "curl -sf http://acc020:30000/v1/models && echo OK || echo NOTREADY"
```

**When not ready yet:**
```
NOTREADY
```

**When ready (you'll see model data):**
```json
{"object":"list","data":[{"id":"XiaomiMiMo/MiMo-V2-Flash",... }]}
OK
```

### Option B: Check the logs

View the SGLang startup logs:

```bash
# Find and view the latest log
ssh alog "tail -100 /gpfs/projects/ehpc482/dev/logs/*/sglang.log"
```

**Look for these log messages:**

Early stage (loading):
```
[mn5] launching SGLang with tp=8 dp=1
Loading model weights...
```

Ready:
```
INFO:     Started server process [12345]
INFO:     Uvicorn running on http://0.0.0.0:30000
[mn5] http://localhost:30000/v1/models ready after Xs
=============================================
[mn5] SGLang ready!
```

### Option C: Follow logs in real-time

```bash
ssh alog "tail -f /gpfs/projects/ehpc482/dev/logs/*/sglang.log"
```

Press `Ctrl+C` to exit when you see "SGLang ready!"

---

## Step 5: Establish SSH Tunnel

Create a tunnel from your **local machine** through the ACC login node to the compute node running SGLang.

```bash
# Replace 'acc020' with your actual head node
ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 30000:acc020:30000 alog
```

**What this does:**
- `-N`: No remote command (just tunnel)
- `-L 30000:acc020:30000`: Forward local port 30000 → compute node port 30000
- `ServerAliveInterval/CountMax`: Keep connection alive
- `alog`: Connect via ACC login node (can reach compute nodes)

**The tunnel is now active!** Keep this terminal open.

**Note:** The command will appear to hang — this is normal. The tunnel is running.

---

## Step 6: Verify Connection & Test

Open a **new terminal** and test the connection:

### List models:
```bash
curl http://localhost:30000/v1/models | jq .
```

### Simple chat completion:
```bash
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "XiaomiMiMo/MiMo-V2-Flash",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "max_tokens": 256
  }' | jq .
```

### Chat with thinking mode (MiMo-V2-Flash):
```bash
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "XiaomiMiMo/MiMo-V2-Flash",
    "messages": [{"role": "user", "content": "Explain recursion briefly"}],
    "max_tokens": 4096,
    "temperature": 0.8,
    "chat_template_kwargs": {"enable_thinking": true}
  }' | jq .
```

---

## Step 7: Configure Local API Server

For the forska.ai API server to process judgments, it needs to know which model is running.

### Set `SGLANG_MODEL` environment variable

The server filters jobs to only process projects using the current model. Set this **before** starting your API server:

**Option A: Add to `.env.local`** (persistent):
```bash
# In your .env.local file
SGLANG_MODEL=XiaomiMiMo/MiMo-V2-Flash
```

**Option B: Set inline** (temporary):
```bash
SGLANG_MODEL=XiaomiMiMo/MiMo-V2-Flash bun run dev:server
```

> **Note**: If `SGLANG_MODEL` is not set, the server will **not process any judgment jobs** and will log a warning:
> ```
> [getRunningJobs] WARNING: SGLANG_MODEL not set. No jobs will be processed.
> ```

### Verify the model matches

The value of `SGLANG_MODEL` must match what the inference server is using (`--served-model-name`). With the default sbatch configuration, both use `XiaomiMiMo/MiMo-V2-Flash`.

---

## All Commands Summary

Here's the complete sequence in one place:

```bash
# 1. Deploy sbatch script
scp forska-mn5-sglang.sbatch tlog:/gpfs/projects/ehpc482/dev/

# 2. Submit job
ssh glog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL forska-mn5-sglang.sbatch"
# Output: Submitted batch job 12345678

# 3. Wait for job to run (repeat until RUNNING)
ssh glog "squeue -j 12345678 -h -o '%T %N'"
# Output when ready: RUNNING acc020,acc021
# → Head node is: acc020

# 4. Wait for SGLang to be ready (use correct head node)
ssh alog "curl -sf http://acc020:30000/v1/models && echo OK || echo NOTREADY"
# Or watch logs: ssh alog "tail -f /gpfs/projects/ehpc482/dev/logs/*/sglang.log"

# 5. Establish SSH tunnel (use correct head node)
ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 30000:acc020:30000 alog

# 6. Test (in new terminal)
curl http://localhost:30000/v1/models | jq .
```

---

## Troubleshooting

### Job stuck in PENDING

```bash
# Check reason for pending
ssh glog "squeue -u \$USER -t pending -o '%i %j %R'"
```

Common reasons:
- `(Resources)`: Waiting for GPUs to become available
- `(Priority)`: Other jobs have higher priority

### SGLang not starting / crashes

```bash
# Check full log
ssh alog "cat /gpfs/projects/ehpc482/dev/logs/*/sglang.log"

# Check for OOM or CUDA errors
ssh alog "grep -i 'error\|oom\|cuda' /gpfs/projects/ehpc482/dev/logs/*/sglang.log"
```

### Tunnel disconnects

Use `autossh` for automatic reconnection:

```bash
brew install autossh  # macOS
autossh -M 0 -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" -N -L 30000:acc020:30000 alog
```

### Cancel a running job

```bash
ssh glog "scancel 12345678"  # Replace with your job ID
```

---

## Key Paths on MN5

| Path | Description |
|------|-------------|
| `/gpfs/projects/ehpc482/dev/` | Main development directory |
| `/gpfs/projects/ehpc482/dev/hf_cache/` | HuggingFace model cache |
| `/gpfs/projects/ehpc482/dev/logs/<jobid>/` | Job-specific logs |
| `/gpfs/projects/ehpc482/dev/sglang_latest.sif` | SGLang container |
| `/gpfs/projects/ehpc482/dev/forska-mn5-sglang.sbatch` | Slurm batch script |

---

## Related Documentation

- [README_MN5_INFERENCE.md](./README_MN5_INFERENCE.md) - Quick-start and automated commands
- [README_MN5_SETUP.md](./README_MN5_SETUP.md) - Initial MN5 account setup
- [MN5_PLAN.md](../MN5_PLAN.md) - Full deployment architecture
- [forska-mn5-sglang.sbatch](../forska-mn5-sglang.sbatch) - The Slurm batch script (detailed comments)
