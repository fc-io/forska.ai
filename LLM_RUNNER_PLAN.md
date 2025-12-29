# LLM Runner Server (Option A) — Plan

**Status**: 🟡 Draft
**Last Updated**: 2025-12-29

## Goal

Create a dedicated Bun/Elysia “llm-server” that can:

- Submit and monitor Slurm `sbatch` jobs running SGLang on **multiple HPCs** (and multiple concurrent runs per HPC)
- Manage and health-check **SSH local-forward tunnels** to each running SGLang instance
- Provide the API server with **connection info** (`url/port`) + **capabilities** (model + settings) for each run
- Keep **all state in-memory only** (no DB, no local persistence, no UI)

This plan is specifically for **Option A: control-plane + direct tunnels** (API server talks directly to the forwarded local port).

## Non-goals (for first iteration)

- No UI
- No long-term persistence (beyond optional re-discovery from Slurm on startup)
- No model transfer/build automation (assume models/containers already exist on each HPC)
- No generic “run arbitrary shell” API

## Constraints / Style

- Follow `CLAUDE.md` rules (functional style, avoid classes, prefer recursion over loops, minimize branching, avoid try/catch unless necessary, named exports)
- No DB migrations; no new storage
- Network access is via existing local `ssh` config/credentials

## Architecture (Option A)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ LOCAL HOST                                                               │
│                                                                          │
│  ┌──────────────────────────┐        ┌───────────────────────────────┐  │
│  │ API server (existing)     │        │ llm-server (new)              │  │
│  │ - creates judging jobs    │  HTTP  │ - sbatch submit               │  │
│  │ - uses returned URL/port  │◄──────►│ - squeue/sacct monitor        │  │
│  │ - calls SGLang directly   │        │ - tail logs                   │  │
│  └───────────────┬──────────┘        │ - ssh -L tunnel manager        │  │
│                  │                   └───────────────┬───────────────┘  │
│                  │ direct HTTP to localhost:PORT                      │
│                  ▼                                                    │
│         http://127.0.0.1:<allocatedPort>/v1/...                       │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ SSH to HPC login nodes
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ HPC (per cluster)                                                        │
│ - Slurm login node(s): sbatch/squeue/scontrol                            │
│ - Compute node(s): SGLang listens on remotePort (e.g. 30000)             │
└──────────────────────────────────────────────────────────────────────────┘
```

## Config Strategy (multiple config files)

### Inputs

Use existing HPC configs in `config/hpc_*.json` as the core source of truth (they already include:
cluster identity, ssh aliases, storageRoot, default model, and SGLang settings).

Add an llm-runner-specific overlay per HPC (either as optional fields in the same JSON, or as a separate JSON “runner config”).

### Recommended: repeatable `--config`

Run llm-server with multiple configs:

```bash
bun --env-file=.env.local run src/llmServer/index.ts \
  --config config/hpc_mn5.json \
  --config config/hpc_alvis.json \
  --config config/hpc_dis.json
```

Merge semantics:

- Each config file contributes one or more `hpc` entries keyed by `name`
- On conflict: `last-config-wins` for scalar defaults; **additive** for model catalogs
- Reject duplicate `name` unless explicitly allowed via a `--allow-override` flag (to prevent footguns)

### Minimal runner overlay (per HPC)

Needed in addition to current schema:

- Which SSH host alias to use for:
  - `sbatch` submission (`general` vs `acc`)
  - tunnel creation (often `acc`)
- How to launch SGLang:
  - reference to an `SBATCH_FILE` already on the cluster (or repo-relative file to upload)
  - which env vars/exports to pass (`SGLANG_MODEL`, `SGLANG_PORT`, `TP_SIZE`, etc.)
- Local tunnel policy:
  - local bind host (`127.0.0.1` default)
  - allowed local port range (to avoid collisions with the API server and other tools)

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
- `portsInUse: Set<number>` (owned by llm-server only; plus OS-level availability checks)

## Public API (llm-server)

Prefix all routes with `/api/llm-runner`.

### Discovery

- `GET /health` → `{ok: true}`
- `GET /hpcs` → list loaded HPC configs (sanitized; no secrets)
- `GET /hpcs/:hpcName/models` → model catalog (from config)

### Runs

- `POST /runs`
  - body: `{hpcName, modelId?, overrides?}`
  - returns: `{runId, slurmJobId?, state, endpointUrl?, localPort?, capabilities}`
- `GET /runs` → list runs (lightweight summary)
- `GET /runs/:runId` → full run details (status, tunnel info, capabilities)
- `POST /runs/:runId/cancel` → cancels Slurm job + tears down tunnel
- `POST /runs/:runId/tunnel/restart` → restart tunnel + re-check health

### Logs / status

- `GET /runs/:runId/slurm` → raw `scontrol show job` (sanitized) + parsed fields
- `GET /runs/:runId/logs?which=stdout|stderr&tail=200`
  - read from Slurm `StdOut`/`StdErr` paths (from `scontrol show job`)
  - return last N lines (no storage)
- Optional later: `GET /runs/:runId/logs/stream` via SSE

## Slurm integration approach

### Submit

Per run:

1. Decide remote working directory (from `connection.storageRoot`)
2. Submit:
   - `ssh <submitHost> "cd <storageRoot> && sbatch --export=ALL,<ENV...> <SBATCH_FILE>"`
3. Parse `Submitted batch job <id>`

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

- Configure a port range (e.g. `31000-31999`) for llm-server to allocate from
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

If llm-server restarts:

- default: forget all runs (pure in-memory)
- optional: “re-discover mode” on startup:
  - query each HPC for jobs matching a naming convention (e.g. `--job-name forska-llm-*`)
  - reconstruct runs in memory and re-establish tunnels

This stays within “no persistence” because the source of truth is Slurm.

## Security considerations

- Require an auth token for all llm-server endpoints (shared secret in env)
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

### Phase 1 — Scaffold llm-server

- Create new entrypoint `src/llmServer/index.ts`
- Add `bun` scripts:
  - `dev:llm-server`
  - `start:llm-server`
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

- Add a small Eden client in the API server to talk to llm-server:
  - request a run, store returned `endpointUrl` per job
  - expose current connectivity/status to existing routes (e.g. `JudgmentsJobsRoutes.ts`)

### Phase 7 — Quality gates

- Run `bun run lint`
- Run `bun test`

## Open questions (need answers before coding)

1. Will llm-server run on the **same host** as the API server (so `127.0.0.1:<port>` is usable)?
2. For each HPC, which SSH alias should be used for:
   - `sbatch` submission
   - `squeue/scontrol` polling
   - tunnels to compute nodes
3. Does each cluster allow login→compute connectivity on the SGLang port (e.g. `30000`)?
4. How many concurrent runs do we expect (to size the local port range and polling frequency)?

