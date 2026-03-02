# LLM Runner Lite — Minimal rsync llm/judge interface

**Status**: Draft  
**Last Updated**: 2026-02-13

## Purpose

Implement only the minimum needed to move llm/judge work to MN5 via rsync:
- local request staging
- rsync to remote shared storage
- remote worker executes request
- rsync results back
- in-memory run tracking

No UI, no DB, no generic shell API.

## Core rule

- MN5 has no outbound internet (no direct HF access).  
- For MN5, run assets/model containers must either already exist on MN5 or be synced explicitly.
- For a run, set `autoTransfer=true` when missing assets are needed: pull on initiating node -> rsync via `tlog`.

## Minimal components

1. `llm-runner` in-memory coordinator (Bun/Elysia).
2. 3 host-side dirs:
   - `data/in/` (outgoing request bundles)
   - `data/out/` (incoming result bundles)
   - `data/archive/` (processed/ack files)
3. One or two sbatch configs already on cluster (`forska-mn5-sglang.sbatch` style).

## Rsync contract

- Request file: `bundle_<model>_<ts>_<seq>.jbnd`
- Result file: `result_<model>_<ts>_<seq>.jbnd`
- Local writer:
  1. write `*.tmp`
  2. `fsync`
  3. rename to `*.jbnd`
  4. rsync only `*.jbnd`
- Remote worker:
  1. process incoming `bundle_*.jbnd`
  2. emit `result_*.jbnd`
  3. rsync only `*.jbnd`

## Minimal run states

- `idle`
- `transferring` (only when `autoTransfer=true` and assets are fetched+rsynced)
- `submitting`
- `pending`
- `warming_up`
- `available`
- `running`
- `completed`
- `failed`

## Flow (MN5-oriented)

1. API call creates a run with model + judge payload + `autoTransfer` flag.
2. If `autoTransfer=true`, runner:
   - pull model/container artifact on initiating node (or reuse cache)
   - rsync to MN5 via `tlog`
3. Runner writes request bundle and rsyncs bundle to remote staging path.
4. Runner submits/monitors sbatch job.
5. Worker reads and processes bundle.
6. Worker writes result bundle.
7. Runner rsyncs results back and updates run status.

## Minimal scripts/commands

- `bun run llm-runner` (coordination service)
- `bun run mn5:launch -- --model <model> --auto-transfer` for on-demand MN5 sync path
- Optional: scheduled rsync pull script for results if no persistent tunnel

## Acceptance criteria

- A request submitted with `autoTransfer=false` fails fast if MN5 lacks required assets.
- A request submitted with `autoTransfer=true` succeeds end-to-end when model/container missing on MN5.
- Only `*.jbnd` files are included in rsync operations.
- No partial/corrupt `.jbnd` file is ever consumed.
- Run state transitions reflect each queue/job/result stage.

## Out of scope

- full scheduler abstraction
- UI for progress
- schema persistence
- retry policy beyond a simple failed/ retryable marker
