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
- Model transfer is explicit: no automatic transfer from initiating node unless `autoTransfer` is enabled for that request. On MN5 (no outbound internet), use `autoTransfer` when artifacts are not already present.
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
- Transfer behavior for runs:
  - `autoTransfer` (default false): pull model/container from Hugging Face on initiating node + rsync to HPC only when true
  - `autoTransfer=false`: require artifacts already present on target HPC
  - MN5 policy: this flag must be true whenever required artifacts are missing because MN5 cannot reach Hugging Face directly.
- Local tunnel policy:
  - local bind host (`127.0.0.1` default)
  - allowed local port range (to avoid collisions with the API server and other tools)

### sbatch scripts as source of truth (parseable config)

**Approach**: Keep sbatch scripts as the canonical source of truth. Make them parseable by llm-runner using a standardized `FORSKA_*` env var defaults block.

**Key insight**: The `: "${VAR:=default}"` bash pattern serves dual purpose:
1. **Functional**: Sets the variable for use later in the script
2. **Parseable**: llm-runner can extract config by parsing these lines

#### sbatch script structure

```bash
#!/bin/bash
#SBATCH -J forska-mn5-sglang
#SBATCH -A ehpc482
#SBATCH --partition=acc
#SBATCH --qos=acc_debug
#SBATCH --nodes=2
#SBATCH --gres=gpu:4
#SBATCH --time=02:00:00
#SBATCH -o %x-%j.log
#SBATCH --export=ALL
#SBATCH --signal=B:USR1@120

# === FORSKA CONFIG ===
: "${FORSKA_HPC:=mn5}"
: "${FORSKA_MODEL:=XiaomiMiMo/MiMo-V2-Flash}"
: "${FORSKA_PORT:=30000}"
: "${FORSKA_TP_SIZE:=8}"
: "${FORSKA_DP_SIZE:=1}"
: "${FORSKA_MAX_RUNNING:=128}"
: "${FORSKA_MEM_FRACTION:=0.75}"
: "${FORSKA_CONTAINER:=singularity}"
: "${FORSKA_SCRIPT_TYPE:=sglang-only}"
# === END CONFIG ===

set -euo pipefail

# Variables are now available for use:
echo "[forska] Launching SGLang: model=$FORSKA_MODEL tp=$FORSKA_TP_SIZE dp=$FORSKA_DP_SIZE"

$FORSKA_CONTAINER exec --nv ... \
  python -m sglang.launch_server \
    --model-path "$FORSKA_MODEL" \
    --port "$FORSKA_PORT" \
    --tensor-parallel-size "$FORSKA_TP_SIZE" \
    --data-parallel-size "$FORSKA_DP_SIZE" \
    --max-running-requests "$FORSKA_MAX_RUNNING" \
    --mem-fraction-static "$FORSKA_MEM_FRACTION"
```

#### Overriding at submit time

Values can be overridden without editing the script:

```bash
sbatch --export=ALL,FORSKA_MODEL=Qwen/Qwen3-30B-A3B forska-mn5-sglang.sbatch
```

#### Parsing in llm-runner

**Parse FORSKA config block**:

```typescript
interface ForskaConfig {
  hpc: string;
  model: string;
  port: number;
  tpSize: number;
  dpSize: number;
  maxRunning: number;
  memFraction: number;
  container: 'singularity' | 'apptainer';
  scriptType: 'sglang-only' | 'full-stack';
}

const parseForskaConfig = (script: string): ForskaConfig => {
  const defaults: Record<string, string> = {};

  // Match: : "${FORSKA_XXX:=value}"
  const regex = /: "\$\{FORSKA_(\w+):=([^}]+)\}"/g;
  let match;
  while ((match = regex.exec(script)) !== null) {
    defaults[match[1]] = match[2];
  }

  return {
    hpc: defaults.HPC ?? 'unknown',
    model: defaults.MODEL ?? '',
    port: Number(defaults.PORT) || 30000,
    tpSize: Number(defaults.TP_SIZE) || 1,
    dpSize: Number(defaults.DP_SIZE) || 1,
    maxRunning: Number(defaults.MAX_RUNNING) || 128,
    memFraction: Number(defaults.MEM_FRACTION) || 0.9,
    container: (defaults.CONTAINER as 'singularity' | 'apptainer') ?? 'apptainer',
    scriptType: (defaults.SCRIPT_TYPE as 'sglang-only' | 'full-stack') ?? 'sglang-only',
  };
};
```

**Parse Slurm directives** (for resource allocation info):

```typescript
interface SlurmConfig {
  jobName?: string;
  account?: string;
  partition?: string;
  qos?: string;
  nodes: number;
  gpusPerNode: number;
  gpuType?: string;
  time?: string;
}

const parseSlurmConfig = (script: string): SlurmConfig => {
  const get = (pattern: RegExp) => script.match(pattern)?.[1];

  // GPU: "--gres=gpu:4" or "--gpus-per-node=A100fat:3"
  const gresMatch = script.match(/#SBATCH\s+--gres=gpu:(\d+)/);
  const gpuPerNodeMatch = script.match(/#SBATCH\s+--gpus-per-node=([^:\s]+):(\d+)/);

  return {
    jobName: get(/#SBATCH\s+(?:-J|--job-name)[=\s]+(\S+)/),
    account: get(/#SBATCH\s+(?:-A|--account)[=\s]+(\S+)/),
    partition: get(/#SBATCH\s+(?:-p|--partition)[=\s]+(\S+)/),
    qos: get(/#SBATCH\s+--qos[=\s]+(\S+)/),
    nodes: Number(get(/#SBATCH\s+--nodes[=\s]+(\d+)/)) || 1,
    gpusPerNode: gresMatch ? Number(gresMatch[1]) :
                 gpuPerNodeMatch ? Number(gpuPerNodeMatch[2]) : 1,
    gpuType: gpuPerNodeMatch?.[1],
    time: get(/#SBATCH\s+--time[=\s]+(\S+)/),
  };
};
```

**Combined parser**:

```typescript
const parseSbatchScript = (script: string) => ({
  forska: parseForskaConfig(script),
  slurm: parseSlurmConfig(script),
});
```

#### HPC-specific differences (handled in each sbatch)

| Setting | MN5 | Alvis | DIS |
|---------|-----|-------|-----|
| Account | `-A ehpc482` | `-A NAISS2025-22-715` | `--account=...` |
| Partition | `acc` | `alvis` | `common` |
| QOS | `acc_debug` | *(none)* | `ehpc-aif-...` |
| GPU gres | `--gres=gpu:4` | `--gpus-per-node=A100fat:3` | `--gres=gpu:2` |
| Container | `singularity` | `apptainer` | `apptainer` |
| Script type | sglang-only | full-stack | full-stack |

#### Standard FORSKA variables

| Variable | Description | Example |
|----------|-------------|---------|
| `FORSKA_HPC` | HPC identifier | `mn5`, `alvis`, `dis` |
| `FORSKA_MODEL` | HuggingFace model ID | `XiaomiMiMo/MiMo-V2-Flash` |
| `FORSKA_PORT` | SGLang server port | `30000` |
| `FORSKA_TP_SIZE` | Tensor parallel size | `8` |
| `FORSKA_DP_SIZE` | Data parallel size | `1` |
| `FORSKA_MAX_RUNNING` | Max concurrent requests | `128` |
| `FORSKA_MEM_FRACTION` | GPU memory fraction | `0.75` |
| `FORSKA_CONTAINER` | Container runtime | `singularity`, `apptainer` |
| `FORSKA_SCRIPT_TYPE` | Script type | `sglang-only`, `full-stack` |

#### Benefits

- **Single source of truth**: sbatch script is the canonical config
- **Functional + parseable**: Config vars work as bash AND can be extracted
- **Overridable**: `--export` allows runtime overrides without editing
- **Self-documenting**: Anyone reading the script sees the config block
- **Consistent**: `FORSKA_` prefix makes config vars easy to grep
- **Testable**: Scripts can be tested directly on the cluster
- **No generation step**: No templates, no build step, no drift

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
    | "transferring"            // explicit transfer from initiating node: HF pull + rsync to remote host
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

---

## JBND v1 — Binary Bundle File Format

A minimal, fast, and future-proof binary "JSON bundle" spec for spool files, designed for:

- **Append-only records**
- **Zero JSON parsing on the spooling side**
- **Fast sequential read/write**
- **Safe partial-write detection**
- Optional integrity checks

### Endianness

All integers are **little-endian**.

### File Layout

```
[FileHeader]
[Record 0]
[Record 1]
...
[Record N-1]
(optional) [Footer]
```

---

### 1) FileHeader (fixed 32 bytes)

| Offset | Size | Type  | Name            | Notes                                                            |
| -----: | ---: | ----- | --------------- | ---------------------------------------------------------------- |
|      0 |    4 | bytes | magic           | ASCII `"JBND"`                                                   |
|      4 |    2 | u16   | version         | `1`                                                              |
|      6 |    2 | u16   | header_len      | bytes of extra header data after this fixed header (usually `0`) |
|      8 |    4 | u32   | flags           | bitfield (see below)                                             |
|     12 |    8 | u64   | created_unix_ns | optional, set 0 if unused                                        |
|     20 |   12 | bytes | reserved        | set to 0                                                         |

**Flags bits:**

- bit 0: `PER_RECORD_CRC32C` (record ends with crc32c)
- bit 1: `HAS_FOOTER` (file ends with footer)
- others reserved (0)

If `header_len > 0`, you can add TLVs later without breaking v1 readers (they skip unknown extra bytes).

---

### 2) Record Framing (fast skip + streaming)

Each record is:

```
u32 record_len
u8  record_type
u8  record_flags
u16 reserved
u8[16] uuid
u32 payload_len
u8[payload_len] payload_json_utf8
(optional) u32 crc32c
```

**Field meanings:**

- `record_len`: number of bytes **after** `record_len` up to (and including) optional CRC
- `record_type`:
  - `1` = request
  - `2` = response
- `record_flags` (for future use; set 0 for now)
- `uuid`: 16 raw bytes (RFC 4122 canonical order) – i.e. Python `uuid.UUID(...).bytes`
- `payload_json_utf8`: **raw JSON bytes** exactly as received/produced (no escaping wrapper)
- optional `crc32c`: CRC32C of the record bytes **excluding** `record_len` and excluding the crc itself (i.e. hash `record_type..payload`)

**Why both `record_len` and `payload_len`?**

- `record_len` lets readers **skip unknown record types** fast and recover from partial tails
- `payload_len` makes it easy to locate payload without computing offsets

**Truncation rule:** if EOF occurs before a full record is read (based on `record_len`), treat the final record as incomplete and ignore/retry the file.

---

### 3) Optional Footer (24 bytes)

If you want a quick "sealed + verified" marker:

```
bytes[4]  footer_magic = "JEND"
u32       record_count
u64       file_xxh3_64  (or 0 if unused)
u32       footer_crc32c (of footer fields excluding this crc) (or 0)
u32       reserved
```

This lets you distinguish "fully written" from "partially written" even if a writer crash happens after rename (rare, but possible on weird setups).

In practice, many people skip the footer and rely on:

1. Write to `.tmp`
2. `fsync`
3. Rename to `.ready`
4. Only rsync `.ready`

---

### Recommended Operational Pattern

1. Local server writes `bundle_<ts>_<seq>.jbnd.tmp`
2. Write header, then records
3. `fsync`, close
4. Rename to `bundle_... .jbnd` (atomic)
5. rsync only `*.jbnd`
6. HPC job processes and writes `result_... .jbnd` back the same way

---

### TypeScript (Bun) — Writer

```ts
import { openSync, closeSync, writeSync, fsyncSync, renameSync } from "fs";

function u32le(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u16le(n: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}
function u64le(nBig: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(nBig, 0);
  return b;
}

// Convert UUID string -> 16 bytes canonical
function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  return Buffer.from(hex, "hex");
}

type Rec = { id: string; payloadJsonUtf8: Uint8Array; type: 1 | 2 };

export function writeJbnd(pathTmp: string, pathFinal: string, recs: Rec[]) {
  const fd = openSync(pathTmp, "w");

  // Header (32 bytes)
  const magic = Buffer.from("JBND");
  const version = u16le(1);
  const headerLen = u16le(0);
  const flags = u32le(0); // set bit0 if you add CRC32C, bit1 if footer
  const createdNs = u64le(BigInt(Date.now()) * 1_000_000n);
  const reserved = Buffer.alloc(12, 0);

  writeSync(fd, Buffer.concat([magic, version, headerLen, flags, createdNs, reserved]));

  for (const r of recs) {
    const uuidBytes = uuidToBytes(r.id);
    if (uuidBytes.length !== 16) throw new Error("bad uuid");

    const payload = Buffer.from(r.payloadJsonUtf8);
    const payloadLen = payload.length;

    // record body
    const body = Buffer.concat([
      Buffer.from([r.type, 0]),    // record_type, record_flags
      Buffer.alloc(2, 0),          // reserved u16
      uuidBytes,                   // 16 bytes
      u32le(payloadLen),
      payload
    ]);

    // record_len excludes the u32 record_len field itself
    writeSync(fd, u32le(body.length));
    writeSync(fd, body);
  }

  fsyncSync(fd);
  closeSync(fd);
  renameSync(pathTmp, pathFinal);
}
```

### TypeScript (Bun) — Reader (streaming)

```ts
import { openSync, closeSync, readSync } from "fs";

function readExact(fd: number, n: number): Buffer | null {
  const b = Buffer.alloc(n);
  const got = readSync(fd, b, 0, n, null);
  if (got === 0) return null;
  if (got !== n) throw new Error("truncated");
  return b;
}

export function readJbnd(path: string, onRecord: (r: { type: number; idHex: string; payload: Buffer }) => void) {
  const fd = openSync(path, "r");

  try {
    const hdr = readExact(fd, 32);
    if (!hdr) throw new Error("empty");
    if (hdr.subarray(0, 4).toString("ascii") !== "JBND") throw new Error("bad magic");

    while (true) {
      const lenBuf = readExact(fd, 4);
      if (!lenBuf) break; // clean EOF
      const recordLen = lenBuf.readUInt32LE(0);

      const rec = readExact(fd, recordLen); // throws if truncated tail
      if (!rec) throw new Error("truncated");
      const type = rec.readUInt8(0);

      const uuidBytes = rec.subarray(4, 20);
      const idHex = uuidBytes.toString("hex"); // format as you like

      const payloadLen = rec.readUInt32LE(20);
      const payload = rec.subarray(24, 24 + payloadLen);

      onRecord({ type, idHex, payload });
    }
  } catch (e) {
    // If you want "ignore truncated last record", catch "truncated" and treat as partial file.
    throw e;
  } finally {
    closeSync(fd);
  }
}
```

---

### Speed Knobs

1. **UUID as 16 bytes** (binary) rather than 36-byte text – free win in size and parse cost.

2. **Compression**: if your bottleneck is network/storage, compress the whole `.jbnd` into `.jbnd.zst` after sealing (fastest operationally). If your bottleneck is CPU and the link is very fast, skip compression.

---

## Open questions (need answers before coding)

1. Will llm-runner run on the **same host** as the API server (so `127.0.0.1:<port>` is usable)?
2. For each HPC, which SSH alias should be used for:
   - `sbatch` submission
   - `squeue/scontrol` polling
   - tunnels to compute nodes
3. Does each cluster allow login→compute connectivity on the SGLang port (e.g. `30000`)?
4. How many concurrent runs do we expect (to size the local port range and polling frequency)?
