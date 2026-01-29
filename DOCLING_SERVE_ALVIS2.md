# Docling Serve on Alvis2 (GPU)

## Problem

Running Docling Serve locally on Mac (CPU-only) is too slow for PDF → Markdown conversion (~2-5 minutes per PDF). We need GPU acceleration on Alvis2's A100 GPUs.

## Goal

Run Docling Serve with GPU/PyTorch on Alvis2, accessible from local machine via SSH tunnel on port 5001 (same as local Docker).

## Assumptions / Pre-reqs

- Local: SSH alias `alvis2` (or change in scripts), `bun`, `curl`, `lsof`
- Alvis2: `apptainer` available (may require `module load Apptainer`), writable `$STACK_ROOT`, outbound access to `ghcr.io` (or prebuilt SIF), login node can reach compute node hostnames
- Port: local `5001` must be free (stop local Docling Docker, or use another port + set `DOCLING_SERVE_URL`)

## Architecture

```
┌─────────────────────┐         ┌─────────────────────────────┐
│  Local Machine      │         │  Alvis2 (A100 GPU)          │
│                     │   SSH   │                             │
│  localhost:5001 ────┼────────►│  docling-serve:5001         │
│  (tunnel)           │  tunnel │  (Apptainer + PyTorch)      │
│                     │         │                             │
│  forska.ai app      │         │  docling_serve_pytorch.sif  │
│  (dev:server)       │         │                             │
└─────────────────────┘         └─────────────────────────────┘
```

## Components

### 1. Sbatch Job File

**File**: `forska-docling-alvis.sbatch`

Similar to `forska-alvis.sbatch` but much simpler — only runs Docling Serve:

```bash
#!/bin/bash
#SBATCH -J forska-docling
#SBATCH -A NAISS2025-22-715 -p alvis
#SBATCH --nodes=1
#SBATCH --gpus-per-node=A100fat:1    # Only need 1 GPU for Docling
#SBATCH --time=08:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

set -euo pipefail

echo "[docling] starting on host $(hostname) at $(date)"

# Paths
export STACK_ROOT=${STACK_ROOT:-/mimer/NOBACKUP/groups/clin-agent-bench/dev}
mkdir -p "$STACK_ROOT"/{logs,.cache/docling}
cd "$STACK_ROOT"

# Container
SIF_DOCLING="$STACK_ROOT/docling_serve_pytorch.sif"
[[ -f "$SIF_DOCLING" ]] || { echo "[docling] missing: $SIF_DOCLING" >&2; exit 2; }

# Logging
LOG_DIR="$STACK_ROOT/logs/${SLURM_JOB_ID:-manual}"
mkdir -p "$LOG_DIR"

# Port
DOCLING_PORT=${DOCLING_PORT:-5001}

# GPU detection
if command -v nvidia-smi &>/dev/null; then
  nvidia-smi --query-gpu=name,memory.total --format=csv
fi

# Cleanup handler
graceful_shutdown() {
  echo "[docling] shutting down..."
  [[ -n "${DOCLING_PID:-}" ]] && kill -TERM "$DOCLING_PID" 2>/dev/null || true
  sleep 2
  [[ -n "${DOCLING_PID:-}" ]] && kill -KILL "$DOCLING_PID" 2>/dev/null || true
}
trap graceful_shutdown EXIT INT TERM USR1

# Start Docling Serve
echo "[docling] starting Docling Serve on :$DOCLING_PORT"

apptainer exec --cleanenv --nv \
  --env DOCLING_SERVE_ARTIFACTS_PATH=/opt/app-root/src/.cache/docling/models \
  --env GUNICORN_TIMEOUT="600" \
  --env DOCLING_SERVE_MAX_SYNC_WAIT="600" \
  --bind "$STACK_ROOT/.cache/docling:/opt/app-root/src/.cache/docling:rw" \
  "$SIF_DOCLING" \
  python -m docling_serve --host 0.0.0.0 --port "$DOCLING_PORT" \
  >"$LOG_DIR/docling.log" 2>&1 &
DOCLING_PID=$!

# Wait for service to be ready
wait_for_http() {
  local url="$1" timeout="${2:-300}"
  echo "[docling] waiting for $url..."
  for ((i=1; i<=timeout; i+=2)); do
    if curl -sf --connect-timeout 2 --max-time 4 "$url" >/dev/null 2>&1; then
      echo "[docling] ready after ${i}s"
      return 0
    fi
    sleep 2
  done
  echo "[docling] timeout waiting for $url"
  return 1
}

wait_for_http "http://localhost:$DOCLING_PORT/health" 300

echo ""
echo "=============================================="
echo "[docling] Docling Serve ready!"
echo "  Host:     $(hostname)"
echo "  Endpoint: http://$(hostname):$DOCLING_PORT"
echo ""
echo "SSH tunnel from local machine:"
echo "  ssh -N -L $DOCLING_PORT:$(hostname):$DOCLING_PORT alvis2"
echo ""
echo "Test:"
echo "  curl http://localhost:$DOCLING_PORT/health"
echo "=============================================="

# Machine-readable config block for scripts to parse
echo ""
echo "[docling:config:start]"
echo "DOCLING_HOST=$(hostname)"
echo "DOCLING_PORT=$DOCLING_PORT"
echo "[docling:config:end]"

# Keep running
wait
```

### 2. Launch Script

**File**: `scripts/doclingAlvisLaunch.ts`

Orchestration script (run locally) that:

1. Pulls/builds the Apptainer SIF if needed
2. Deploys sbatch file
3. Submits job
4. Waits for job to start
5. Establishes SSH tunnel on port 5001

**Pattern**: Follow `scripts/mn5Launch.ts` structure.

```typescript
/**
 * Launch Docling Serve on Alvis2 and set up SSH tunnel
 * Usage: bun run docling:alvis:launch
 */

import {$, spawn} from 'bun'

const STACK_ROOT = '/mimer/NOBACKUP/groups/clin-agent-bench/dev'
const SSH_HOST = 'alvis2' // Login node for sbatch and tunnel
const DOCLING_PORT = 5001
const SBATCH_FILE = 'forska-docling-alvis.sbatch'
const SIF_NAME = 'docling_serve_pytorch.sif'
const DOCKER_IMAGE = 'ghcr.io/docling-project/docling-serve:pytorch'

const log = (m: string): void => {
  console.log(`[docling:alvis] ${m}`)
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => setTimeout(r, ms))
}

// Job management functions similar to mn5Launch.ts...

const main = async () => {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const skipBuild = args.includes('--skip-build')

  // 1. Check/build SIF image
  if (!skipBuild) {
    log('Checking for Docling SIF image...')
    const sifExists = await $`ssh ${SSH_HOST} "test -f ${STACK_ROOT}/${SIF_NAME} && echo EXISTS || echo MISSING"`.text()

    if (sifExists.includes('MISSING') || force) {
      log('Building Docling Serve SIF (this may take a few minutes)...')
      await $`ssh ${SSH_HOST} "cd ${STACK_ROOT} && apptainer pull --force ${SIF_NAME} docker://${DOCKER_IMAGE}"`
      log('SIF image built successfully')
    } else {
      log('SIF image already exists (use --force to rebuild)')
    }
  }

  // 2. Check for existing jobs
  log('Checking for existing Docling jobs...')
  const existingJob =
    await $`ssh ${SSH_HOST} "squeue -u \\$USER -n forska-docling -h -o '%i|%T|%N' 2>/dev/null || echo ''"`.text()
  // ... similar to mn5Launch.ts job management ...

  // 3. Deploy sbatch file
  log('Deploying sbatch file...')
  await $`scp ${SBATCH_FILE} ${SSH_HOST}:${STACK_ROOT}/`

  // 4. Submit job
  log('Submitting job...')
  const result = await $`ssh ${SSH_HOST} "cd ${STACK_ROOT} && sbatch ${SBATCH_FILE}"`.text()
  const jobIdMatch = result.match(/Submitted batch job (\d+)/)
  if (!jobIdMatch) {
    console.error('Failed to submit job:', result)
    process.exit(1)
  }
  const jobId = jobIdMatch[1]
  log(`Job submitted: ${jobId}`)

  // 5. Wait for job to start and Docling to be ready
  // ... similar to mn5Launch.ts ...

  // 6. Start SSH tunnel
  await startTunnel(computeNode)
}
```

### 3. Tunnel Management

The tunnel runs in the foreground (similar to `mn5DevServer.ts`):

```typescript
const startTunnel = async (computeNode: string): Promise<void> => {
  log(`Starting SSH tunnel: localhost:${DOCLING_PORT} -> ${computeNode}:${DOCLING_PORT}`)

  // Kill any existing process on port 5001
  await $`lsof -i :${DOCLING_PORT} -t 2>/dev/null | xargs kill 2>/dev/null || true`
  await sleep(500)

  const proc = spawn(
    [
      'ssh',
      '-N',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `${DOCLING_PORT}:${computeNode}:${DOCLING_PORT}`,
      SSH_HOST,
    ],
    {stdout: 'inherit', stderr: 'inherit'},
  )

  // Wait for tunnel to be ready
  await sleep(2000)

  // Verify connection
  const check =
    await $`curl -sf --connect-timeout 5 http://localhost:${DOCLING_PORT}/health && echo OK || echo FAIL`.text()
  if (check.includes('OK')) {
    log('✓ Tunnel connected and Docling responding')
  }

  log(`Docling Serve available at http://localhost:${DOCLING_PORT}`)
  log('Press Ctrl+C to disconnect')

  await proc.exited
}
```

### 4. Package.json Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "docling:alvis:launch": "bun scripts/doclingAlvisLaunch.ts",
    "docling:alvis:status": "ssh alvis2 'squeue -u $USER -n forska-docling'",
    "docling:alvis:cancel": "ssh alvis2 'scancel -u $USER -n forska-docling'",
    "docling:alvis:logs": "ssh alvis2 'tail -f /mimer/NOBACKUP/groups/clin-agent-bench/dev/logs/*/docling.log'"
  }
}
```

## SIF Image

### Docker Image

Use the **PyTorch** variant for GPU acceleration:

```
ghcr.io/docling-project/docling-serve:pytorch
```

### Building the SIF

The launch script handles this automatically, but manual build:

```bash
ssh alvis2
cd /mimer/NOBACKUP/groups/clin-agent-bench/dev
apptainer pull docling_serve_pytorch.sif docker://ghcr.io/docling-project/docling-serve:pytorch
```

**Note**: `apptainer pull` downloads the container image. Model weights are fetched on first conversion and cached under `.cache/docling`.

## Workflow

### First-time Setup

```bash
# From local machine
bun run docling:alvis:launch
```

This will:

1. Build the SIF image (first run only, ~10-15 minutes)
2. Submit the sbatch job
3. Wait for job to start (queue time varies)
4. Wait for Docling to load models (~2-5 minutes)
5. Start SSH tunnel on port 5001

### Daily Usage

```bash
# Check if job is already running
bun run docling:alvis:status

# Launch/reconnect
bun run docling:alvis:launch
```

### Stop / Cleanup

- Stop tunnel: `Ctrl+C` in the `docling:alvis:launch` terminal
- Cancel job: `bun run docling:alvis:cancel` (or `ssh alvis2 'scancel <jobid>'`)

### Running with Local Dev Server

Terminal 1:

```bash
bun run docling:alvis:launch
# Keep this running for the tunnel
```

Terminal 2:

```bash
bun run dev:server
# Uses DOCLING_SERVE_URL=http://localhost:5001 (default)
```

## Configuration

### Environment Variables

No changes needed! The existing `DOCLING_SERVE_URL=http://localhost:5001` works because the SSH tunnel makes the remote service appear local.

### Timeout Settings

The sbatch configures these env vars in the container:

- `GUNICORN_TIMEOUT=600` — Worker timeout (10 minutes)
- `DOCLING_SERVE_MAX_SYNC_WAIT=600` — Max time to wait for sync conversion

These match the current `docker-compose.yml` settings.

## GPU Requirements

- **GPU count**: 1× A100 (40GB or 80GB fat)
- **VRAM needed**: ~8-12GB for model inference
- **Why A100fat?**: More headroom for complex PDFs; A100 (40GB) also works

The sbatch requests `--gpus-per-node=A100fat:1`.

## Model Caching

Docling downloads ~5GB of models on first run. These are cached in:

```
$STACK_ROOT/.cache/docling/
```

Bound into the container at `/opt/app-root/src/.cache/docling`.

## Comparison with Local Docker

| Aspect          | Local (CPU)                 | Alvis2 (GPU)                   |
| --------------- | --------------------------- | ------------------------------ |
| Conversion time | 2-5 min/PDF                 | 10-30 sec/PDF                  |
| Setup           | `docker compose up docling` | `bun run docling:alvis:launch` |
| Port            | 5001                        | 5001 (via tunnel)              |
| Cost            | Free                        | Uses GPU allocation            |
| Persistence     | Always running              | Sbatch job (8 hours)           |

## Checklist

### Setup

- [x] Create `forska-docling-alvis.sbatch`
- [x] Create `scripts/doclingAlvisLaunch.ts`
- [x] Add package.json scripts
- [x] Add a cancel/cleanup command (`scancel`)
- [ ] Test SIF build on Alvis2
- [ ] Test sbatch submission
- [ ] Verify SSH tunnel works

### Testing

- [ ] Verify GPU detection in sbatch logs
- [ ] Test conversion speed vs local CPU
- [ ] Test with large/complex PDFs
- [ ] Verify integration with `fullTextConversionJobs.ts`

### Documentation

- [ ] Add to `README.md`
- [ ] Add troubleshooting section

## Troubleshooting

### SIF Build Fails

```bash
# Check disk space
ssh alvis2 'df -h /mimer/NOBACKUP/groups/clin-agent-bench/dev'

# Manual build with more verbosity
ssh alvis2
cd /mimer/NOBACKUP/groups/clin-agent-bench/dev
apptainer pull --force docling_serve_pytorch.sif docker://ghcr.io/docling-project/docling-serve:pytorch
```

If `apptainer` is missing:

```bash
ssh alvis2 'module load Apptainer || true; apptainer --version'
```

If `ghcr.io` is blocked from Alvis2: build/pull the SIF somewhere with outbound access, then `scp` it into `$STACK_ROOT/`.

### Job Won't Start

```bash
# Check queue status
ssh alvis2 'squeue -u $USER'

# Check why job is pending
ssh alvis2 'scontrol show job <jobid> | grep -i reason'
```

### Tunnel Disconnects

The launch script uses keepalives, but if it disconnects:

```bash
# Reconnect (finds existing job)
bun run docling:alvis:launch
```

### Slow Conversions

Check the logs:

```bash
ssh alvis2 'tail -100 /mimer/NOBACKUP/groups/clin-agent-bench/dev/logs/*/docling.log'
```

Common issues:

- First conversion is slow (model loading)
- Very large PDFs still take time even with GPU
- Check if using GPU: look for CUDA messages in logs

## Future Improvements

- [ ] Add login-node health check (curl from `alvis2` to the compute node)
- [ ] Consider `--pipeline vlm` for complex/scanned PDFs (GraniteDocling VLM)
- [ ] Automatic tunnel restart on disconnect
- [ ] Combine with main forska-alvis sbatch (single job for all services)
