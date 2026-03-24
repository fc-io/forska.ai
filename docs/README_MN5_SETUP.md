# MareNostrum 5 — SGLang Deployment Guide

This guide covers deploying SGLang to MareNostrum 5 (MN5) at Barcelona Supercomputing Center (BSC) for inference. Due to MN5's network restrictions (no outbound calls from compute nodes), we pre-download models and containers locally, then transfer them via the transfer node.

## Prerequisites

### Local Machine

- Docker (for pulling/saving container images)
- HuggingFace CLI (`pip install huggingface-hub[cli]`)
- SSH configuration for BSC (see below)
- ~60GB disk space for model + container

### MN5 Access

- Active allocation on MN5 (project: `ehpc482`)
- SSH keys configured for `alog` (compute) and `tlog` (transfer)

## SSH Configuration

Add to `~/.ssh/config`:

```ssh-config
Host alog
  HostName alogin2.bsc.es
  User hrev337517
  IdentityFile ~/.ssh/id_ed25519_bsc
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
  ServerAliveInterval 60
  ServerAliveCountMax 3

Host tlog
  HostName transfer4.bsc.es
  User hrev337517
  IdentityFile ~/.ssh/id_ed25519_bsc
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
  ServerAliveInterval 60
  ServerAliveCountMax 3
```

## Directory Structure on MN5

All files live under the shared GPFS storage:

```
/gpfs/projects/ehpc482/dev/
├── sglang_latest.sif          # SGLang Apptainer container
├── forska-mn5-sglang.sbatch   # Job script
├── hf_cache/                   # HuggingFace model cache
│   └── models--Qwen--Qwen3-30B-A3B-Instruct-2507/
├── logs/                       # Job logs (per job ID)
│   └── <jobid>/
│       ├── sglang-*.log
│       └── sglang-router.log
├── .cache/                     # SGLang/PyTorch caches
│   └── sglang/
├── .secrets/                   # Credentials (chmod 600)
│   └── hf_token.txt
└── tmp/                        # Temporary files
```

## Step-by-Step Setup

### 1. Download Model Locally

```bash
# Login to HuggingFace (one-time, if using gated models)
huggingface-cli login

# Download model (adjust model name as needed)
huggingface-cli download Qwen/Qwen3-30B-A3B-Instruct-2507 \
  --local-dir ./models/Qwen3-30B-A3B-Instruct-2507 \
  --local-dir-use-symlinks False

# Verify download (~30GB for this model)
du -sh ./models/Qwen3-30B-A3B-Instruct-2507
```

### 2. Prepare Container Locally

```bash
# Pull SGLang container
docker pull lmsysorg/sglang:latest

# Save as tarball for transfer
docker save lmsysorg/sglang:latest | gzip > ./models/sglang_latest.tar.gz

# Verify (~8GB compressed)
ls -lh ./models/sglang_latest.tar.gz
```

### 3. Transfer to MN5

Use the transfer node (`tlog`) for large file transfers:

```bash
# Create remote directories
ssh tlog "mkdir -p /gpfs/projects/ehpc482/dev/{hf_cache,logs,.cache,.secrets,tmp}"

# Transfer model (uses rsync for resumable transfers)
rsync -avzP --info=progress2 \
  ./models/Qwen3-30B-A3B-Instruct-2507/ \
  tlog:/gpfs/projects/ehpc482/dev/hf_cache/models--Qwen--Qwen3-30B-A3B-Instruct-2507/

# Transfer container tarball
rsync -avzP --info=progress2 \
  ./models/sglang_latest.tar.gz \
  tlog:/gpfs/projects/ehpc482/dev/
```

### 4. Convert Container on MN5

SSH to the compute login node to convert the Docker tarball to Apptainer SIF:

```bash
ssh alog

cd /gpfs/projects/ehpc482/dev

# Load apptainer module (if needed)
module load apptainer 2>/dev/null || module load singularity 2>/dev/null || true

# Convert Docker image to Apptainer SIF (~15GB uncompressed)
apptainer build sglang_latest.sif docker-archive:sglang_latest.tar.gz

# Cleanup tarball to save space
rm sglang_latest.tar.gz

# Verify
ls -lh sglang_latest.sif
```

### 5. Upload Secrets (Optional)

If your model requires HuggingFace authentication:

```bash
# Create token file locally
echo "hf_YOUR_TOKEN_HERE" > /tmp/hf_token.txt

# Transfer securely
scp /tmp/hf_token.txt tlog:/gpfs/projects/ehpc482/dev/.secrets/

# Set permissions on MN5
ssh alog "chmod 600 /gpfs/projects/ehpc482/dev/.secrets/hf_token.txt"

# Cleanup local file
rm /tmp/hf_token.txt
```

### 6. Upload sbatch Script

```bash
scp forska-mn5-sglang.sbatch tlog:/gpfs/projects/ehpc482/dev/
```

### 7. Submit Job

```bash
# Submit from login node
ssh alog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL forska-mn5-sglang.sbatch"

# Check job status
ssh alog "squeue -u hrev337517"

# Get detailed job info
ssh alog "scontrol show job <JOBID>"
```

### 8. Connect via SSH Tunnel

Once the job is running, establish a tunnel to the SGLang endpoint:

```bash
# Get the compute node hostname
COMPUTE_NODE=$(ssh alog "squeue -u hrev337517 -h -o '%N' | head -1")

# Establish tunnel
ssh -N -L 30000:${COMPUTE_NODE}:30000 alog

# Or use the helper script
./scripts/mn5Tunnel.sh
```

### 9. Test Connection

```bash
# List available models
curl -sf http://localhost:30000/v1/models | jq .

# Send a test completion
curl -sf http://localhost:30000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen/Qwen3-30B-A3B-Instruct-2507",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 50
  }' | jq .
```

## Running Different Models

To run a different model:

1. **Download locally**: `huggingface-cli download <model-id> --local-dir ./models/<model-name>`
2. **Transfer to MN5**: `rsync -avzP ./models/<model-name>/ tlog:/gpfs/projects/ehpc482/dev/hf_cache/models--<org>--<model-name>/`
3. **Update sbatch**: Change the model/runtime settings in `forska-mn5-sglang.sbatch` (this is launcher metadata, not local app env)
4. **Resubmit job**

### Model Path Format

HuggingFace cache uses this naming convention:

- Model ID: `Qwen/Qwen3-30B-A3B-Instruct-2507`
- Cache path: `hf_cache/models--Qwen--Qwen3-30B-A3B-Instruct-2507/`

## Scaling to Multiple Nodes

The sbatch script supports multi-node deployment:

```bash
# Request 2 nodes (8 GPUs total)
sbatch -N 2 --export=ALL forska-mn5-sglang.sbatch

# Request 4 nodes (16 GPUs total)
sbatch -N 4 --export=ALL forska-mn5-sglang.sbatch
```

The router automatically discovers all workers and load-balances across them.

## Monitoring

### Job Logs

```bash
# Follow all logs for latest job
ssh alog "tail -f /gpfs/projects/ehpc482/dev/logs/\$(squeue -u hrev337517 -h -o '%i' | head -1)/*.log"

# View specific service
ssh alog "tail -100 /gpfs/projects/ehpc482/dev/logs/<JOBID>/sglang-router.log"
```

### GPU Utilization

```bash
# From within a job (interactive or via srun)
ssh alog "srun --jobid=<JOBID> --overlap nvidia-smi"
```

### SGLang Metrics

With the tunnel active:

```bash
# Prometheus metrics
curl -sf http://localhost:30000/metrics

# Server info
curl -sf http://localhost:30000/get_model_info | jq .
```

## Troubleshooting

### Container Build Fails

```bash
# Check apptainer version
apptainer --version

# Try with more verbose output
apptainer build --debug sglang_latest.sif docker-archive:sglang_latest.tar.gz
```

### Job Won't Start

```bash
# Check pending reason
squeue -u hrev337517 -t pending -o "%.10i %.9P %.8j %.8u %.8T %.10M %.9l %.6D %R"

# Check account/allocation status
myquota  # or equivalent command on MN5
```

### Model Not Found

Ensure the model is in the correct cache location:

```bash
ssh alog "ls -la /gpfs/projects/ehpc482/dev/hf_cache/"

# The model directory should match HF cache naming:
# models--<org>--<model-name>/snapshots/<hash>/
```

### SSH Tunnel Disconnects

Use `autossh` for persistent tunnels:

```bash
# Install autossh
brew install autossh  # macOS
# or: apt install autossh  # Linux

# Use instead of ssh
autossh -M 0 -N -L 30000:<compute-node>:30000 alog
```

## Integration with forska.ai

Once the tunnel is established, start the local API server with runtime metadata if needed:

```bash
bun run mn5:dev:server
```

Then configure the provider/model in Forska at `/admin/models` to use the tunnel endpoint, for example `http://localhost:30000/v1`.

Do not add a global inference URL to env files for normal app use.

## Quick Reference

| Task             | Command                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Submit job       | `ssh alog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL forska-mn5-sglang.sbatch"` |
| Check status     | `ssh alog "squeue -u hrev337517"`                                                          |
| Cancel job       | `ssh alog "scancel <JOBID>"`                                                               |
| View logs        | `ssh alog "tail -f /gpfs/projects/ehpc482/dev/logs/<JOBID>/*.log"`                         |
| Get node name    | `ssh alog "squeue -u hrev337517 -h -o '%N'"`                                               |
| Establish tunnel | `ssh -N -L 30000:<node>:30000 alog`                                                        |
| Test endpoint    | `curl http://localhost:30000/v1/models`                                                    |
