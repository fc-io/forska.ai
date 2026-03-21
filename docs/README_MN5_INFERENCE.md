# MareNostrum 5 (MN5) Inference Guide

**Purpose**: Step-by-step instructions for running inference with MN5 as the remote SGLang server.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start (One-Command Launch)](#quick-start-one-command-launch)
3. [First-Time Setup](#first-time-setup)
4. [Establishing the SSH Tunnel](#establishing-the-ssh-tunnel)
5. [Connecting from Local Machine](#connecting-from-local-machine)
6. [Testing Inference](#testing-inference)
7. [Monitoring & Status](#monitoring--status)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before using MN5 for inference, ensure:

1. **SSH Configuration**: Your `~/.ssh/config` includes the BSC hosts (`tlog`, `glog`, `alog`). See example below.
2. **SSH Key Added**: `ssh-add ~/.ssh/id_ed25519_bsc`
3. **Dependencies Installed**: Bun runtime, rsync, curl

### SSH Config Example

```ssh-config
# Transfer login (for rsync, file transfers)
Host tlog
  HostName transfer4.bsc.es
  User hrev337517
  IdentityFile ~/.ssh/id_ed25519_bsc
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
  ServerAliveInterval 60
  ServerAliveCountMax 3

# General purpose login (has singularity module, for sbatch)
Host glog
  HostName glogin1.bsc.es
  User hrev337517
  IdentityFile ~/.ssh/id_ed25519_bsc
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
  ServerAliveInterval 60
  ServerAliveCountMax 3

# ACC login (for SSH tunnels)
Host alog
  HostName alogin2.bsc.es
  User hrev337517
  IdentityFile ~/.ssh/id_ed25519_bsc
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
  ServerAliveInterval 60
  ServerAliveCountMax 3
```

---

## Quick Start (One-Command Launch)

If you've already done the first-time setup (model and container transferred), use:

```bash
bun run mn5:launch
```

Large-context profile:

```bash
bun run mn5:launch -- --large-context
```

This automated command will:

1. Deploy the sbatch script to MN5
2. Submit the job to the queue
3. Wait for the job to start running
4. Wait for SGLang to be ready (10-20 min for large models)
5. Automatically establish an SSH tunnel to `localhost:30000`

Once complete, you can immediately start making inference requests!

---

## First-Time Setup

If this is your first time deploying to MN5, you need to transfer the model and container:

### Step 1: Transfer Model + Container

```bash
bun run mn5:transfer
```

This will:

- Download the model from HuggingFace (if not cached locally)
- Pull the SGLang Docker container (linux/amd64)
- Transfer both to MN5 via the `tlog` transfer node

> **Note**: This takes ~1 hour depending on your internet connection.

### Transfer Options

```bash
# Transfer a different model
bun run mn5:transfer -- --model Qwen/Qwen3-30B-A3B-Instruct-2507

# Skip download if model already exists locally
bun run mn5:transfer -- --skip-download

# Skip container if already on MN5
bun run mn5:transfer -- --skip-container
```

### Step 2: Launch SGLang

```bash
bun run mn5:launch
```

## Establishing the SSH Tunnel

The SSH tunnel creates a secure connection between your local machine and the SGLang server running on MN5 compute nodes.

### Automatic Tunnel (Recommended)

The `mn5:launch` command automatically establishes the tunnel. If you need to reconnect:

```bash
bun run mn5:tunnel
```

This script:

- Auto-detects which compute node is running your job
- Establishes an SSH tunnel via `alog` (ACC login node)
- Forwards `localhost:30000` to the SGLang API on the compute node

### Manual Tunnel Setup

If you need to set up the tunnel manually:

```bash
# 1. Find your running job's node
ssh alog "squeue -u \$USER -o '%N %j %T' | grep RUNNING"

# Example output: acc020,acc021 forska-sglang RUNNING
# The first node (acc020) is the head node with the API

# 2. Establish tunnel (replace acc020 with your actual node)
ssh -N -L 30000:acc020:30000 alog
```

### Tunnel Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Local Machine                                                   │
│  localhost:30000 ────► SSH Tunnel via alog ────► acc020:30000   │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  MN5 Compute (Multi-Node, tp=8)                                  │
│                                                                  │
│  acc020 (Head Node)          acc021 (Worker Node)               │
│  ├─ SGLang API :30000        ├─ SGLang Worker                   │
│  ├─ GPUs 0-3                 └─ GPUs 4-7                        │
│  └─ Exposes OpenAI API           (NCCL communication)           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Connecting from Local Machine

Once the tunnel is established, the SGLang server is accessible at `http://localhost:30000`.

### Configure Forska to Use MN5

If you want the local API server to pick up launcher/runtime metadata, start it with:

```bash
bun run mn5:dev:server
```

Then configure the provider/model in Forska at `/admin/models` to use the tunnel endpoint, for example `http://localhost:30000/v1`.

Do not add a global inference URL to `.env.local` for normal app use.

### OpenAI-Compatible API

The SGLang server exposes an OpenAI-compatible API. Use it like any OpenAI endpoint:

| Endpoint                    | Description           |
| --------------------------- | --------------------- |
| `GET /v1/models`            | List available models |
| `POST /v1/chat/completions` | Chat completions      |
| `POST /v1/completions`      | Text completions      |
| `GET /health`               | Health check          |

---

## Testing Inference

### List Available Models

```bash
curl http://localhost:30000/v1/models | jq .
```

### Basic Chat Completion

```bash
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "max_tokens": 256
  }' | jq .
```

### Longer Response

```bash
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "messages": [{"role": "user", "content": "Explain the concept of recursion"}],
    "max_tokens": 1024,
    "temperature": 0.7
  }' | jq .
```

### Streaming Response

```bash
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "messages": [{"role": "user", "content": "Write a haiku about computing"}],
    "max_tokens": 256,
    "stream": true
  }'
```

---

## Monitoring & Status

### Check Job Status

```bash
bun run mn5:status
```

Or manually:

```bash
# All your jobs
ssh alog "squeue -u \$USER"

# Detailed info
ssh alog "squeue -u \$USER -o '%i %j %T %M %N %R'"
```

### View SGLang Logs

```bash
# Recent log output
ssh alog "tail -100 /gpfs/projects/ehpc482/dev/logs/*/sglang.log"

# Follow logs in real-time
ssh alog "tail -f /gpfs/projects/ehpc482/dev/logs/*/sglang.log"
```

### Cancel Running Job

```bash
# Find job ID
ssh alog "squeue -u \$USER"

# Cancel it
ssh alog "scancel <JOB_ID>"
```

---

## Troubleshooting

### SSH Tunnel Dies / Connection Dropped

The tunnel may disconnect over time. Reconnect with:

```bash
bun run mn5:tunnel
```

Or install `autossh` for automatic reconnection:

```bash
brew install autossh
autossh -M 0 -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" -N -L 30000:acc020:30000 alog
```

### "Connection Refused" on localhost:30000

1. **Check if job is running**:

   ```bash
   ssh alog "squeue -u \$USER"
   ```

2. **Check if SGLang is ready** (large models take 15-20 min to load):

   ```bash
   ssh alog "tail -20 /gpfs/projects/ehpc482/dev/logs/*/sglang.log"
   ```

   Look for: `INFO: Started server process`

3. **Verify tunnel is active**: Check if the SSH tunnel process is running

### Job Stuck in PENDING State

```bash
# Check why
ssh alog "squeue -u \$USER -t pending -o '%i %j %R'"
```

Common reasons:

- **Resources**: Waiting for GPU nodes to become available
- **Priority**: Other jobs in queue have higher priority

### Permission Denied on SSH

```bash
# Ensure SSH key is loaded
ssh-add -l

# If not, add it
ssh-add ~/.ssh/id_ed25519_bsc
```

### Model Not Loading / SGLang Timeout

Large models can take 15-20 minutes to load. Check the logs:

```bash
ssh alog "tail -100 /gpfs/projects/ehpc482/dev/logs/*/sglang.log"
```

---

## Quick Reference

| Task                       | Command                   |
| -------------------------- | ------------------------- |
| Full launch (one-command)  | `bun run mn5:launch`      |
| Transfer model + container | `bun run mn5:transfer`    |
| Connect to running job     | `bun run mn5:tunnel`      |
| Check job status           | `bun run mn5:status`      |
| Submit job only            | `bun run mn5:submit`      |
| Deploy sbatch script       | `bun run mn5:sbatch:push` |
| Mount MN5 storage          | `bun run mn5:mount`       |
| Unmount MN5 storage        | `bun run mn5:unmount`     |

---

## Related Documentation

- [README_MN5_SETUP.md](./README_MN5_SETUP.md) - Initial MN5 account setup
- [MN5_PLAN.md](../plans/MN5_PLAN.md) - Full deployment plan with architecture details
- [forska-mn5-sglang.sbatch](../forska-mn5-sglang.sbatch) - The Slurm batch script
