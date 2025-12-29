# LLM Runner Server — Plan

**Status**: 🟡 Draft
**Last Updated**: 2025-12-29

## Goal

Create a dedicated Bun/Elysia `llm-runner` that can:

- Submit and monitor Slurm `sbatch` jobs running SGLang on **multiple HPCs** (and multiple concurrent runs per HPC)
- Manage and health-check **SSH local-forward tunnels** to each running SGLang instance
- Provide the API server with **connection info** (`url/port`) + **capabilities** (model + settings) for each run
- Keep **all state in-memory only** (no DB, no local persistence, no UI)

## Non-goals (for first iteration)

- No UI
- No long-term persistence (beyond optional re-discovery from Slurm on startup)
- No model transfer/build automation (assume models/containers already exist on each HPC)
- No generic “run arbitrary shell” API

## Constraints / Style

- Follow `CLAUDE.md` rules (functional style, avoid classes, prefer recursion over loops, minimize branching, avoid try/catch unless necessary, named exports)
- Never use `any` — use `unknown` with type guards or proper types
- Use [ArkType](https://arktype.io/) for runtime validation
- Use [Effect](https://effect.website/) for typed effects, error handling, and concurrency
- Use Bun shell (`Bun.spawn` / `Bun.$`) for running bash commands (ssh, sbatch, squeue, etc)
- No DB migrations; no new storage
- Network access is via existing local `ssh` config/credentials

## Config Strategy (multiple config files)

### Inputs

Use existing HPC configs in `config/hpc_*.json` as the core source of truth.

Add runner-specific fields directly to each `hpc_*.json` file.

### Recommended: repeatable `--config`

Run llm-runner with multiple configs:

```bash
# Minimal (no env file required):
bun run src/llmServer/index.ts \
  --config config/hpc_mn5.json \
  --config config/hpc_alvis.json \
  --config config/hpc_dis.json

# Or with optional env file (for LLM_RUNNER_AUTH_TOKEN shared secret):
bun --env-file=.env.local run src/llmServer/index.ts \
  --config config/hpc_mn5.json \
  --config config/hpc_alvis.json \
  --config config/hpc_dis.json
```

Merge semantics:

- Each config file contributes one or more `hpc` entries keyed by `name`
- On conflict: `last-config-wins` for scalar defaults; **additive** for model catalogs
- Reject duplicate `name` unless explicitly allowed via a `--allow-override` flag (to prevent footguns)

### Runner fields in `hpc_*.json`

Additional fields to add to existing schema:

- Which SSH host alias to use for:
  - `sbatch` submission (`general` vs `acc`)
  - tunnel creation (often `acc`)
- How to launch SGLang:
  - reference to an `SBATCH_FILE` already on the cluster (or repo-relative file to upload)
  - which env vars/exports to pass (`SGLANG_MODEL`, `SGLANG_PORT`, `TP_SIZE`, etc.)
- Local tunnel policy:
  - local bind host (`127.0.0.1` default)
  - allowed local port range (to avoid collisions with the API server and other tools)

### Template-based sbatch generation (eliminate redundancy)

**Problem**: Currently, the same settings (nodes, GPUs, account, etc.) are defined in both:
1. Config files (`hpc_*.json`) — the intended source of truth
2. sbatch scripts (`#SBATCH` directives) — hard-coded duplicates

This leads to drift, errors, and maintenance overhead.

**Solution**: llm-runner generates sbatch scripts at runtime from config + templates.

#### HPC-specific differences to handle

| Setting | MN5 | Alvis | DIS |
|---------|-----|-------|-----|
| Account directive | `-A ehpc482` | `-A NAISS2025-22-715` | `--account=...` |
| Partition | `--partition=acc` | `-p alvis` | `-p common` |
| QOS | `--qos=acc_debug` | *(none)* | `--qos=...` |
| GPU gres format | `--gres=gpu:4` | `--gpus-per-node=A100fat:3` | `--gres=gpu:2` |
| Container runtime | `singularity` | `apptainer` | `apptainer` |
| Script type | SGLang-only | Full stack | Full stack |
| Extra directives | `--ntasks-per-node`, `--cpus-per-task` | — | `--ntasks-per-node`, `--cpus-per-task` |

#### Config schema additions

Add to `hpc_*.json`:

```jsonc
{
  "slurm": {
    // Directives that become #SBATCH lines
    "account": "ehpc482",
    "partition": "acc",
    "qos": "acc_debug",               // optional
    "nodes": 2,
    "gpusPerNode": 4,
    "gpuType": null,                  // e.g. "A100fat" for Alvis
    "time": "02:00:00",
    "ntasksPerNode": 4,               // optional
    "cpusPerTask": 20,                // optional

    // Controls which template to use
    "scriptType": "sglang-only",      // or "full-stack"
    "containerRuntime": "singularity" // or "apptainer"
  }
}
```

#### Template implementation: Typed template literal functions

**Approach**: Use TypeScript template literal functions with a **resolver layer** that pre-computes all values. Templates receive only simple strings—no conditionals or logic in the template itself.

**Principle**: All HPC-specific logic lives in the resolver; templates are clean string interpolations.

#### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  HPC Config     │────▶│    Resolver     │────▶│    Template     │
│  (hpc_*.json)   │     │ (computes vals) │     │ (pure strings)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

#### Resolver: Pre-compute all template values

The resolver transforms raw config into ready-to-use strings:

```typescript
interface SbatchTemplateVars {
  // Header lines (each is a complete #SBATCH line or empty string)
  jobNameLine: string;        // "#SBATCH -J forska-mn5-sglang"
  accountLine: string;        // "#SBATCH -A ehpc482"
  partitionLine: string;      // "#SBATCH --partition=acc" or ""
  qosLine: string;            // "#SBATCH --qos=acc_debug" or ""
  nodesLine: string;          // "#SBATCH --nodes=2"
  gpuLine: string;            // "#SBATCH --gres=gpu:4" or "#SBATCH --gpus-per-node=A100fat:3"
  timeLine: string;           // "#SBATCH --time=02:00:00"
  ntasksLine: string;         // "#SBATCH --ntasks-per-node=4" or ""
  cpusLine: string;           // "#SBATCH --cpus-per-task=20" or ""

  // Runtime values
  containerRuntime: string;   // "singularity" or "apptainer"
  stackRoot: string;          // "/gpfs/projects/ehpc482/dev"
  sglangModel: string;        // "XiaomiMiMo/MiMo-V2-Flash"
  sglangPort: string;         // "30000"
  tpSize: string;             // "8"
  dpSize: string;             // "1"
  // ... etc
}

const resolveSbatchVars = (hpc: HpcConfig): SbatchTemplateVars => ({
  jobNameLine: `#SBATCH -J forska-${hpc.name}-sglang`,
  accountLine: hpc.slurm.accountStyle === 'short'
    ? `#SBATCH -A ${hpc.slurm.account}`
    : `#SBATCH --account=${hpc.slurm.account}`,
  partitionLine: hpc.slurm.partition
    ? `#SBATCH --partition=${hpc.slurm.partition}`
    : '',
  qosLine: hpc.slurm.qos
    ? `#SBATCH --qos=${hpc.slurm.qos}`
    : '',
  nodesLine: `#SBATCH --nodes=${hpc.slurm.nodes}`,
  gpuLine: hpc.slurm.gpuType
    ? `#SBATCH --gpus-per-node=${hpc.slurm.gpuType}:${hpc.slurm.gpusPerNode}`
    : `#SBATCH --gres=gpu:${hpc.slurm.gpusPerNode}`,
  timeLine: `#SBATCH --time=${hpc.slurm.time}`,
  ntasksLine: hpc.slurm.ntasksPerNode
    ? `#SBATCH --ntasks-per-node=${hpc.slurm.ntasksPerNode}`
    : '',
  cpusLine: hpc.slurm.cpusPerTask
    ? `#SBATCH --cpus-per-task=${hpc.slurm.cpusPerTask}`
    : '',
  containerRuntime: hpc.slurm.containerRuntime,
  stackRoot: hpc.connection.storageRoot,
  // ... etc
});
```

#### Template: Pure string interpolation

Templates are simple functions that just concatenate pre-computed lines:

```typescript
const renderSbatchHeader = (v: SbatchTemplateVars): string => [
  '#!/bin/bash',
  v.jobNameLine,
  v.accountLine,
  v.partitionLine,
  v.qosLine,
  v.nodesLine,
  v.gpuLine,
  v.timeLine,
  v.ntasksLine,
  v.cpusLine,
  '#SBATCH -o %x-%j.log',
  '#SBATCH --export=ALL',
  '#SBATCH --signal=B:USR1@120',
].filter(Boolean).join('\n');
```

**Key benefit**: The template function has **zero conditionals**—all logic is in the resolver.

#### Generation flow

1. **On `POST /models/:id/start`**:
   - Load `HpcConfig` for the requested model
   - Call `resolveSbatchVars(hpcConfig)` to pre-compute all values
   - Call template functions (header + body) with resolved values
   - Validate the rendered script (non-empty required lines, valid time format)
   - Write to temp file on remote host via SSH
   - Submit: `ssh <host> "sbatch /path/to/rendered.sbatch"`

2. **Validation** (in resolver, before template):
   - Required fields present in config
   - Numeric ranges valid (`nodes >= 1`, `gpusPerNode >= 1`)
   - Time format valid (`HH:MM:SS`)
   - Container runtime is `singularity` or `apptainer`

#### Benefits

- **Type-safe**: Full TypeScript types from config to template
- **Testable**: Resolver logic can be unit tested independently
- **Clean templates**: No conditionals, just interpolation
- **IDE support**: Autocomplete and refactoring work seamlessly
- **Single source of truth**: Config drives everything
- **Auditable**: Can log the resolved vars and rendered script

## In-memory Domain Model

### Core entities

- `HpcConfig` (loaded at startup; read-only)
- `Run` (in-memory; created/updated/removed)
  - `runId` (ULID)
  - `hpcName`
  - `model` + resolved SGLang args
  - `slurmJobId`
  - `slurmState` (+ timestamps)
  - `computeHost` (resolved from Slurm once RUNNING)
  - `remotePort` (from config or run override)
  - `localPort` (allocated)
  - `tunnelPid` (ssh process handle)
  - `endpointUrl` (derived, e.g. `http://127.0.0.1:31234`)
  - `health` (last successful `/v1/models` or `/health` check)

### Registries

- `runsById: Map<string, Run>`
- `portsInUse: Set<number>` (owned by llm-runner only; plus OS-level availability checks)

## Public API (llm-runner)

### Models

Models are loaded from config files. Each model has a lifecycle state the API server can poll.

- `GET /models` → list all models with current state

Response per model:

```ts
{
  // Lifecycle state
  state:
    | "idle"                    // not running, ready to start
    | "transferring"            // transferring files to remote host
    | "initializing"            // submitting sbatch
    | "pending"                 // queued in Slurm (PENDING)
    | "started"                // sbatch stared, tunnel not up
    | "loading_model"           // log: model weights being loaded
    | "warming_up"              // log: warmup/cuda graph capture in progress
    | "available"               // log: server ready message + tunnel up + /v1/models responds
    // === Terminal states ===
    | "completing"              // Slurm job ending (COMPLETING), tearing down tunnel
    | "completed"               // Slurm job finished normally (time limit, clean exit)
    | "failed"                  // error detected, or Slurm job ended unexpectedly
    | "cancelled",              // manually stopped

  error?: string,               // if state === "failed"

  slurmInfo:{
    slurmJobId?: string,
    startTime?: Date,
    expectedEndTime?: Date,
    endTime?: Date,
  },

  logs: {
    sbatchLogTail?: string,         // latest progress message from logs (e.g. "Loading layer 45/80")
    routerLogTail?: string,         // latest progress message from router logs
    workerLogTail?: string[],       // latest progress message from worker logs
    nvidiaSmiLatest?: string,       // latest progress message from nvidia-smi
  },

  tunnelUrls:{
  // Connection (only when state === "available")
    routerUrl?: string,         // e.g. "http://127.0.0.1:31234"
    workerUrls?: string[],      // e.g. "http://127.0.0.1:31234"
  },

  config: {
    modelId: string,              // from config
    modelName: string,            // from config
    hpcName: string,              // which HPC this model runs on

    // GPU allocation
    gpuNodes: number,             // GPU_NNODES
    gpusPerNode: number,          // GPU_GPUS_PER_NODE
    totalGpus: number,            // GPU_TOTAL_GPUS
    gpuShape: string,             // GPU_SHAPE (e.g. "H100")

    // SGLang parameters
    tensorParallelSize: number,   // TP_SIZE
    dataParallelSize: number,     // DP_SIZE
    maxRunningRequests: number,   // SGLANG_MAX_RUNNING_REQUESTS
  }
}
```

**Log parsing requirements**: The sbatch script must produce parseable log output. Validate that logs contain:
- Model loading progress indicators
- Clear "server ready" message (e.g. SGLang's `"The server is fired up"`)
- Error messages with identifiable patterns

- `POST /models/:modelId/start` → submit sbatch, begin lifecycle
- `POST /models/:modelId/stop` → cancel Slurm job + tear down tunnel
- `GET /models/:modelId/logs?which=stdout|stderr&tail=200` → tail Slurm logs

### Auto-restart

After a model reaches `completed` state (sbatch finished normally), llm-runner can automatically restart it:
- Transition: `completed` → `idle` → `submitting` → ...
- Configurable via `autoRestart: boolean` in model config
- Useful for long-running inference workloads that exceed Slurm time limits

### API server coordination

llm-runner can optionally poll the API server to optimize HPC resource usage:

**Idle cancellation** (`--poll-api-server` flag):
- Periodically check API server for active jobs / pending requests
- If a model has been `available` with no requests for N minutes → `scancel` and free the allocation
- Prevents wasting HPC credits when there's no work

**Demand-driven launching** (`--demand-driven` flag):
- Poll API server: "which models are needed to finish active jobs?"
- Automatically start models that are `idle` but have pending work
- Automatically stop models that have no pending work

API server must expose:
- `GET /api/llm-runner/demand` → `{ modelsNeeded: string[], pendingRequestsByModel: Record<string, number> }`

## Slurm integration approach

### Submit

- Decide remote working directory (from `connection.storageRoot`)
- Submit with `ssh <submitHost> "cd <storageRoot> && sbatch --export=ALL,<ENV...> <SBATCH_FILE>"`
- Parse `Submitted batch job <id>`

### Monitor

Poll per run until terminal state:

- Use `squeue -j <id> -h -o '%T %N'` for fast state + node
- Use `scontrol show job <id>` for:
  - `StdOut`, `StdErr` paths
  - full nodelist, time limits, etc.
- Optionally use `sacct -j <id> --format=...` for completion reason

### Compute host resolution

From `%N` / `NodeList`:

- Pick “head node” as the first concrete hostname
- Support multi-node allocations (take first node for the SGLang HTTP endpoint)

## Tunnel management (SSH -L)

### Creating a tunnel

Once the run is RUNNING and `computeHost` is known:

- Allocate `localPort` (see below)
- Start:
  - `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L <localPort>:<computeHost>:<remotePort> <tunnelHost>`
- Store process handle/pid in the run

### Health checks & restart

Health check should verify the full path, not just “ssh is up”:

- `fetch http://127.0.0.1:<localPort>/v1/models` (or `/health` if available)
- If it fails:
  - check Slurm state (job might have ended)
  - restart tunnel if job is still RUNNING

Use a periodic task (Elysia cron or a single timer) that:

- updates Slurm state for active runs
- validates tunnel + endpoint health
- tears down runs that are terminal (COMPLETED/FAILED/CANCELLED)

### Local port allocation (avoid conflicts)

Requirements:

- multiple concurrent runs must not collide
- must not collide with API server or other local tooling

Strategy:

- Configure a port range (e.g. `31000-31999`) for llm-runner to allocate from
- For each candidate port:
  - check “not in `portsInUse`”
  - check OS availability by attempting to bind a TCP server briefly
- Reserve it in-memory before starting `ssh -L`
- If `ssh` fails with bind error, release and retry next port

Return to API server:

- `endpointUrl: http://127.0.0.1:<localPort>`
- `capabilities`: `{model, contextLength, tensorParallelSize, dataParallelSize, ...}`

## “No storage” operational model

### Restart behavior

If llm-runner restarts:

- default: forget all runs (pure in-memory)
- optional: “re-discover mode” on startup:
  - query each HPC for jobs matching a naming convention (e.g. `--job-name forska-llm-*`)
  - reconstruct runs in memory and re-establish tunnels

This stays within “no persistence” because the source of truth is Slurm.

## Security considerations

- Require an auth token for all llm-runner endpoints (shared secret in env)
- Never accept arbitrary command strings from clients
- Validate all user-provided overrides (ArkType at request boundary)
- Sanitize logs returned via API (paths/identities as needed)
- Bind tunnels to `127.0.0.1` by default (do not expose ports externally unless explicitly configured)

## Implementation Phases

### Phase 0 — Discovery (read-only)

- Inventory current Slurm/SGLang launch scripts (`forska-*.sbatch`, `scripts/*Launch*`, `scripts/*Tunnel*`)
- Confirm per-HPC constraints:
  - which login node to use for `sbatch` vs tunneling
  - whether compute node port is reachable from the chosen login node

### Phase 1 — Scaffold llm-runner

- Create new entrypoint `src/llmServer/index.ts`
- Add `bun` scripts:
  - `dev:llm-runner`
  - `start:llm-runner`
- Add basic Elysia app with `/api/llm-runner/health`

### Phase 2 — Config loader

- Implement repeatable `--config` parsing via `process.argv`
- Load/validate JSON configs (reuse `config/hpc_config_schema.json` + add runner overlay validation)
- Expose `GET /hpcs` and `GET /hpcs/:hpcName/models`

### Phase 3 — Run lifecycle + Slurm client

- Implement `POST /runs`:
  - validate request
  - submit `sbatch` over SSH
  - create `Run` in-memory
- Implement polling to update state and resolve `computeHost`

### Phase 4 — Tunnel manager + port allocator

- Allocate local port and start tunnel process
- Implement health check loop and auto-restart
- Return stable `endpointUrl` to the API server once ready

### Phase 5 — Logs

- Implement `GET /runs/:id/logs` based on `scontrol show job` stdout/stderr paths

### Phase 6 — API server integration

- Add a small Eden client in the API server to talk to llm-runner:
  - request a run, store returned `endpointUrl` per job
  - expose current connectivity/status to existing routes (e.g. `JudgmentsJobsRoutes.ts`)

### Phase 7 — Quality gates

- Run `bun run lint`
- Run `bun test`

## Open questions (need answers before coding)

1. Will llm-runner run on the **same host** as the API server (so `127.0.0.1:<port>` is usable)?
2. For each HPC, which SSH alias should be used for:
   - `sbatch` submission
   - `squeue/scontrol` polling
   - tunnels to compute nodes
3. Does each cluster allow login→compute connectivity on the SGLang port (e.g. `30000`)?
4. How many concurrent runs do we expect (to size the local port range and polling frequency)?
