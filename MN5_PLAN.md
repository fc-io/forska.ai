# MareNostrum 5 (BSC) Deployment Plan

**Status**: ✅ Complete
**Last Updated**: 2025-12-23

## Overview

Deploy SGLang inference server to MareNostrum 5 at Barcelona Supercomputing Center (BSC). Due to MN5's restriction on outbound network calls, we pre-download models and containers locally, then transfer them via the `tlog` transfer node.

**Current Model**: `XiaomiMiMo/MiMo-V2-Flash` (313GB, requires tp=8 across 2 nodes)

---

## 🚀 Quick Start

### One-Command Launch (Recommended)

```bash
# Deploys sbatch, submits job, waits for startup, establishes tunnel
bun run mn5:launch
```

This will:
1. Deploy the sbatch script to MN5
2. Submit the job
3. Wait for the job to start running
4. Wait for SGLang to be ready (10-20 min for large models)
5. Establish SSH tunnel to `localhost:30000`

### First-Time Setup

If you haven't transferred the model and container yet:

```bash
# Step 1: Transfer model + container to MN5 (one-time, ~1 hour)
bun run mn5:transfer

# Step 2: Launch SGLang
bun run mn5:launch
```

### Test Inference

```bash
# List models
curl http://localhost:30000/v1/models | jq .

# Send a request with thinking mode
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2-flash",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "max_tokens": 4096,
    "temperature": 0.8,
    "chat_template_kwargs": {"enable_thinking": true}
  }' | jq .
```

---

## 📋 Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| **mn5:launch** | `bun run mn5:launch` | Full automation: deploy, submit, wait, tunnel |
| **mn5:transfer** | `bun run mn5:transfer` | Download model/container, transfer to MN5 |
| **mn5:tunnel** | `bun run mn5:tunnel` | Connect to running job (auto-detects node) |
| **mn5:status** | `bun run mn5:status` | Check job queue status |
| **mn5:submit** | `bun run mn5:submit` | Submit job (sbatch already deployed) |
| **mn5:sbatch:push** | `bun run mn5:sbatch:push` | Just copy sbatch file to MN5 |
| **mn5:mount** | `bun run mn5:mount` | Mount MN5 storage via SSHFS |
| **mn5:unmount** | `bun run mn5:unmount` | Unmount MN5 storage |

### Script Options

```bash
# Launch with a different model
bun run mn5:launch -- --model Qwen/Qwen3-30B-A3B-Instruct-2507

# Launch without tunnel (just submit)
bun run mn5:launch -- --no-tunnel

# Transfer with different model
bun run mn5:transfer -- --model Qwen/Qwen3-30B-A3B-Instruct-2507

# Transfer skipping download (if model already exists locally)
bun run mn5:transfer -- --skip-download

# Transfer skipping container (if container already on MN5)
bun run mn5:transfer -- --skip-container
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        LOCAL MACHINE                                      │
│  ┌────────────────┐                        ┌─────────────────────────┐   │
│  │  forska.ai     │◄──HTTP via SSH────────►│  HuggingFace CLI        │   │
│  │  API Server    │    tunnel to MN5       │  (download models)      │   │
│  │  localhost:3001│                        └─────────────────────────┘   │
│  └────────────────┘                                                       │
│         │                                                                 │
│         │ SSH tunnel via alog                                             │
│         ▼                                                                 │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       MARENOSTRUM 5 (BSC)                                 │
│                                                                           │
│  Transfer Node (tlog):  transfer4.bsc.es                                  │
│  General Login (glog):  glogin1.bsc.es    (for sbatch, has singularity)  │
│  ACC Login (alog):      alogin2.bsc.es    (for tunnel)                   │
│  Shared Storage:        /gpfs/projects/ehpc482/dev                        │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │              Multi-Node Tensor Parallel (tp=8)                      │ │
│  │                                                                      │ │
│  │  Node 0 (4×H100)              Node 1 (4×H100)                       │ │
│  │  ┌──────────────────┐         ┌──────────────────┐                  │ │
│  │  │ SGLang Head      │◄──NCCL──►│ SGLang Worker    │                  │ │
│  │  │ --node-rank 0    │         │ --node-rank 1    │                  │ │
│  │  │ tp=0,1,2,3       │         │ tp=4,5,6,7       │                  │ │
│  │  │ :30000 (API)     │         │                  │                  │ │
│  │  └────────┬─────────┘         └──────────────────┘                  │ │
│  │           │                                                          │ │
│  │           ▼                                                          │ │
│  │    SSH Tunnel from local → localhost:30000                           │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Files on MN5

| Path | Description | Size |
|------|-------------|------|
| `/gpfs/projects/ehpc482/dev/sglang_latest.sif` | Singularity container (amd64) | ~14GB |
| `/gpfs/projects/ehpc482/dev/hf_cache/models--XiaomiMiMo--MiMo-V2-Flash/` | MiMo-V2-Flash model | ~313GB |
| `/gpfs/projects/ehpc482/dev/forska-mn5-sglang.sbatch` | Batch job script | ~7KB |
| `/gpfs/projects/ehpc482/dev/logs/` | Job output logs | varies |
| `/gpfs/projects/ehpc482/dev/.secrets/hf_token.txt` | HuggingFace token (optional) | <1KB |

---

## Files in Repository

| File | Purpose | Status |
|------|---------|--------|
| `MN5_PLAN.md` | This deployment guide | ✅ Done |
| `forska-mn5-sglang.sbatch` | Slurm job script for SGLang | ✅ Done |
| `scripts/mn5Transfer.ts` | Download + transfer automation | ✅ Done |
| `scripts/mn5Launch.ts` | Full launch automation | ✅ Done |
| `scripts/mn5Tunnel.sh` | SSH tunnel helper (auto-detect) | ✅ Done |

---

## SGLang Configuration (MiMo-V2-Flash)

The sbatch script is configured with MiMo-V2-Flash recommended settings:

| Parameter | Value | Notes |
|-----------|-------|-------|
| `--model-path` | `XiaomiMiMo/MiMo-V2-Flash` | From HF cache |
| `--served-model-name` | `mimo-v2-flash` | API alias |
| `--tensor-parallel-size` | 8 | Across 2 nodes |
| `--context-length` | 131072 | 128K context |
| `--chunked-prefill-size` | 16384 | Per HF recommendation |
| `--max-running-requests` | 128 | Concurrency limit |
| `--mem-fraction-static` | 0.75 | GPU memory allocation |
| `--reasoning-parser` | `qwen3` | For thinking mode |

### Multi-Node Distributed Setup

The sbatch script uses `srun` for proper multi-node tensor parallelism:
- Node 0 (`--node-rank 0`): Head node, exposes API on `:30000`
- Node 1 (`--node-rank 1`): Worker node, communicates via NCCL

```bash
srun --nodes=2 --ntasks=2 --ntasks-per-node=1 \
  bash -c "apptainer exec ... --node-rank $SLURM_PROCID ..."
```

---

## SSH Configuration Reference

```ssh-config
# ~/.ssh/config

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

## Troubleshooting

### Common Issues

1. **"Permission denied" on transfer**
   - Ensure SSH key is added to agent: `ssh-add ~/.ssh/id_ed25519_bsc`

2. **Job stuck in PENDING**
   - Check queue: `ssh alog "squeue -u \$USER -t pending"`
   - May need to wait for resources

3. **SSH tunnel dies unexpectedly**
   - Use `bun run mn5:tunnel` which has keepalive settings
   - Or install `autossh`: `brew install autossh`

4. **"no space left on device" during docker save**
   - Clear Docker cache: `docker builder prune -a --force`
   - Clear unused images: `docker image prune -a`

5. **"invalid tar header" during SIF build**
   - The tarball may be corrupted from Docker disconnecting
   - Delete and re-run: `rm models/sglang_latest.tar.gz && bun run mn5:transfer`

6. **SIF build killed (OOM on login node)**
   - The script automatically submits a batch job for SIF conversion
   - Check with: `ssh glog "squeue -u \$USER"`

7. **Wrong CPU architecture (arm64 vs amd64)**
   - The transfer script uses `--platform linux/amd64` for Docker pull
   - If you have old arm64 container, delete and re-transfer

8. **Model not loading (SGLang timeout)**
   - Check logs: `ssh alog "tail -100 /gpfs/projects/ehpc482/dev/logs/*/sglang.log"`
   - Large models can take 15-20 minutes to load

---

## Notes

- **MareNostrum 5 has NO outbound internet access** - applies to ALL nodes
- All models and containers must be pre-downloaded locally and transferred via `tlog`
- Shared storage at `/gpfs/projects/ehpc482/dev` is accessible from all nodes
- Each compute node has **4× H100 GPUs** (80GB each)
- MiMo-V2-Flash requires **2 nodes (tp=8)** for inference
