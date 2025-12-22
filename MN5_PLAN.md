# MareNostrum 5 (BSC) Deployment Plan

**Status**: 🚧 In Progress
**Last Updated**: 2025-12-20

## Overview

Deploy SGLang inference server to MareNostrum 5 at Barcelona Supercomputing Center (BSC). Due to MN5's restriction on outbound network calls, we pre-download models and containers locally, then transfer them via the `tlog` transfer node.

---

## 🚀 Quick Start: First-Time Setup (Step-by-Step)

Follow these steps in order to get inference running on MN5:

### Step 1: Download model + container locally, transfer to MN5
```bash
# This handles: HuggingFace model download, Docker container save, rsync to MN5
bun run scripts/mn5Transfer.ts
```
> ⏱️ Takes 30-60 min depending on network (downloads ~40GB, uploads ~50GB)

**Stored on MN5 at:**
- Model: `/gpfs/projects/ehpc482/dev/hf_cache/models--XiaomiMiMo--MiMo-V2-Flash/`
- Container: `/gpfs/projects/ehpc482/dev/sglang_latest.sif`

### Step 2: Upload the sbatch script
```bash
scp forska-mn5-sglang.sbatch tlog:/gpfs/projects/ehpc482/dev/
```

### Step 3: Submit the job on MN5
```bash
ssh alog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL forska-mn5-sglang.sbatch"
```

### Step 4: Wait for job to start, then check status
```bash
# Check if job is running
ssh alog "squeue -u hrev337517"

# Once RUNNING, get the compute node name
ssh alog "squeue -u hrev337517 -h -o '%N' -t RUNNING"
```

### Step 5: Establish SSH tunnel to MN5 SGLang
```bash
# Auto-detects compute node from running job
./scripts/mn5Tunnel.sh
```
> Keep this terminal open - it's your connection to SGLang

### Step 6: Test inference locally
```bash
# In a new terminal - list models
curl http://localhost:30000/v1/models | jq .

# Send a test request
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "XiaomiMiMo/MiMo-V2-Flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 50
  }' | jq .
```

### Step 7: Configure forska.ai to use MN5
```bash
# Edit .env.local
VITE_LLM_SERVER_URL=http://localhost:30000/v1
```

Then restart your local API server - it will now route inference to MN5!

---

## 🔄 Daily Usage (After Initial Setup)

Once everything is set up, daily usage is just:

```bash
# 1. Submit job (if not already running)
ssh alog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL forska-mn5-sglang.sbatch"

# 2. Wait ~5-10 min for model to load, then connect
./scripts/mn5Tunnel.sh

# 3. Start your local forska.ai
bun run dev
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
│  Compute Login (alog):  alogin2.bsc.es                                    │
│  Shared Storage:        /gpfs/projects/ehpc482/dev                        │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                 Compute Nodes (4×H100 each)                         │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │ │
│  │  │ SGLang       │  │ SGLang       │  │ SGLang       │  ...          │ │
│  │  │ Worker 0-3   │  │ Worker 4-7   │  │ Worker 8-11  │               │ │
│  │  │ :30001-30004 │  │ :30001-30004 │  │ :30001-30004 │               │ │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │ │
│  │         └─────────────────┼─────────────────┘                        │ │
│  │                           ▼                                          │ │
│  │                  ┌─────────────────┐                                 │ │
│  │                  │  SGLang Router  │◄──SSH Tunnel from local         │ │
│  │                  │     :30000      │                                 │ │
│  │                  └─────────────────┘                                 │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

## Implementation Checklist

### Phase 1: Local Preparation

- [ ] **1.1** Install HuggingFace CLI locally
  ```bash
  uv pip install huggingface-hub[cli]
  # or: brew install huggingface-cli
  ```

- [ ] **1.2** Login to HuggingFace (if using gated models)
  ```bash
  huggingface-cli login
  ```

- [ ] **1.3** Download target model locally
  ```bash
  huggingface-cli download XiaomiMiMo/MiMo-V2-Flash \
    --local-dir ./models/MiMo-V2-Flash
  ```

- [ ] **1.4** Pull SGLang container locally (requires Docker)
  ```bash
  docker pull lmsysorg/sglang:latest
  docker save lmsysorg/sglang:latest | gzip > ./models/sglang_latest.tar.gz
  ```

### Phase 2: Transfer to MN5

- [ ] **2.1** Test SSH connectivity to transfer node
  ```bash
  ssh tlog "echo 'Connected to transfer node'"
  ```

- [ ] **2.2** Create remote directory structure
  ```bash
  ssh tlog "mkdir -p /gpfs/projects/ehpc482/dev/{hf_cache,logs,.cache,.secrets,tmp}"
  ```

- [ ] **2.3** Transfer model to MN5 via tlog
  ```bash
  rsync -avzP --info=progress2 \
    ./models/MiMo-V2-Flash/ \
    tlog:/gpfs/projects/ehpc482/dev/hf_cache/models--XiaomiMiMo--MiMo-V2-Flash/
  ```

- [ ] **2.4** Transfer container tarball to MN5
  ```bash
  rsync -avzP --info=progress2 \
    ./models/sglang_latest.tar.gz \
    tlog:/gpfs/projects/ehpc482/dev/
  ```

- [ ] **2.5** Convert container on MN5 (via alog compute node)
  ```bash
  ssh alog
  cd /gpfs/projects/ehpc482/dev
  # Load apptainer module if needed
  module load apptainer 2>/dev/null || true
  apptainer build sglang_latest.sif docker-archive:sglang_latest.tar.gz
  rm sglang_latest.tar.gz  # cleanup tarball
  ```

### Phase 3: MN5 Configuration

- [ ] **3.1** Upload HuggingFace token to MN5 (if needed for gated models)
  ```bash
  # Create token file locally first
  echo "hf_YOUR_TOKEN_HERE" > /tmp/hf_token.txt
  scp /tmp/hf_token.txt tlog:/gpfs/projects/ehpc482/dev/.secrets/hf_token.txt
  rm /tmp/hf_token.txt
  ```

- [ ] **3.2** Upload sbatch script
  ```bash
  scp forska-mn5-sglang.sbatch tlog:/gpfs/projects/ehpc482/dev/
  ```

- [ ] **3.3** Verify file permissions on MN5
  ```bash
  ssh alog "chmod 600 /gpfs/projects/ehpc482/dev/.secrets/*"
  ```

### Phase 4: Job Submission & Testing

- [ ] **4.1** Submit test job on MN5
  ```bash
  ssh alog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL forska-mn5-sglang.sbatch"
  ```

- [ ] **4.2** Monitor job status
  ```bash
  ssh alog "squeue -u hrev337517"
  ```

- [ ] **4.3** Check job logs
  ```bash
  ssh alog "tail -f /gpfs/projects/ehpc482/dev/logs/*/sglang*.log"
  ```

- [ ] **4.4** Establish SSH tunnel to SGLang
  ```bash
  # Replace <compute-node> with actual node hostname from job output
  ssh -N -L 30000:<compute-node>:30000 alog
  ```

- [ ] **4.5** Test SGLang endpoint locally
  ```bash
  curl -sf http://localhost:30000/v1/models | jq .
  ```

### Phase 5: Production Integration

- [ ] **5.1** Update local forska.ai to use MN5 SGLang endpoint
  ```bash
  # In .env.local
  VITE_LLM_SERVER_URL=http://localhost:30000/v1
  ```

- [ ] **5.2** Create persistent tunnel script
  - See `scripts/mn5Tunnel.sh`

- [ ] **5.3** Document model cache path for future model updates
  - HuggingFace cache: `/gpfs/projects/ehpc482/dev/hf_cache`
  - Container: `/gpfs/projects/ehpc482/dev/sglang_latest.sif`

---

## SSH Configuration Reference

```ssh-config
# ~/.ssh/config

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

---

## Files Created

| File | Purpose | Status |
|------|---------|--------|
| `MN5_PLAN.md` | This implementation plan | ✅ Done |
| `docs/README_MN5_SETUP.md` | Detailed setup guide | ✅ Done |
| `scripts/mn5Transfer.ts` | Automated transfer script | ✅ Done |
| `forska-mn5-sglang.sbatch` | MN5 sbatch for SGLang + Router | ✅ Done |
| `scripts/mn5Tunnel.sh` | SSH tunnel helper (auto-detect) | ✅ Done |

---

## Quick Commands Reference

```bash
# Transfer model and container (one-time setup)
bun run scripts/mn5Transfer.ts

# Upload sbatch script
scp forska-mn5-sglang.sbatch tlog:/gpfs/projects/ehpc482/dev/

# Submit job
ssh alog "cd /gpfs/projects/ehpc482/dev && sbatch --export=ALL forska-mn5-sglang.sbatch"

# Check job status
ssh alog "squeue -u hrev337517"

# Get compute node hostname from running job
ssh alog "squeue -u hrev337517 -h -o '%N' | head -1"

# Establish tunnel (replace <node> with actual hostname)
./scripts/mn5Tunnel.sh <node>

# Test connection
curl http://localhost:30000/v1/models | jq .
```

---

## Troubleshooting

### Common Issues

1. **"Permission denied" on transfer**
   - Ensure SSH key is added to agent: `ssh-add ~/.ssh/id_ed25519_bsc`

2. **"Module not found: apptainer"**
   - Try: `module load singularity` or check with `module avail`

3. **Job stuck in PENDING**
   - Check queue: `squeue -u hrev337517 -t pending`
   - Check account balance: `myquota` or equivalent

4. **SSH tunnel dies unexpectedly**
   - Use the `mn5Tunnel.sh` script with autossh for reconnection
   - Or add to SSH config: `ServerAliveInterval 60`

5. **Model download failed on local machine**
   - Check HuggingFace token: `huggingface-cli whoami`
   - Some models require accepting license on HF website first

---

## Notes

- **MareNostrum 5 has NO outbound internet access** - this applies to ALL nodes (login, compute, and transfer)
- All models and containers must be pre-downloaded locally and transferred via `tlog`
- Shared storage at `/gpfs/projects/ehpc482/dev` is accessible from all nodes
- Each compute node has **4× H100 GPUs** (assumed 80GB each)

---

## Alternative: SSHFS Streaming (No Local Storage)

Instead of downloading to your local machine first, you can mount MN5 storage locally and stream directly:

### Setup (one-time)
```bash
# macOS: Install macFUSE and sshfs
brew install macfuse sshfs

# Create mount point
mkdir -p ~/mnt/mn5
```

### Stream model directly to MN5
```bash
# Mount MN5 storage
sshfs tlog:/gpfs/projects/ehpc482/dev ~/mnt/mn5 \
  -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3

# Download directly to MN5 (no local storage used)
huggingface-cli download XiaomiMiMo/MiMo-V2-Flash \
  --local-dir ~/mnt/mn5/hf_cache/models--XiaomiMiMo--MiMo-V2-Flash \
  --local-dir-use-symlinks False

# Unmount when done
umount ~/mnt/mn5
```

**Pros:**
- No local disk space required
- Files go directly to MN5

**Cons:**
- Slower than download + rsync (SSH overhead on every write)
- macFUSE can be finicky on newer macOS versions
- If connection drops, download may need to restart

