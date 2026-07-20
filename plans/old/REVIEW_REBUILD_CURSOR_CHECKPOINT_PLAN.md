# Review Rebuild Cursor Checkpoint Plan

## Scope

Replace long-term review-serving rebuild work fan-out with cursor/checkpoint execution.

This is the structural follow-up to `REVIEW_REBUILD_WORK_FANOUT_PLAN.md`. The near-term plan reduces overhead while keeping the current chunk-manifest model. This plan describes the long-term model where a logical rebuild task advances through durable checkpoints instead of creating one manifest row per tiny executable child.

## Problem Statement

Chunk manifests give good safety properties:

- resumability
- retries
- visibility
- bounded work
- lease ownership

But for broad rebuilds they can become too granular. A large project can produce thousands of child chunks, and each child pays queue overhead:

- select/claim
- lease update
- split recovery
- validation/finalization
- per-chunk diagnostics

When chunks execute in ~100-200 ms and claim/select takes ~70-80 ms, the queue has become a major part of runtime.

The long-term fix is to keep the safety properties without representing every small bite as a separate manifest row.

## Core Model

Represent rebuild work as a logical task with a durable cursor:

```text
request_id
component
project_id
snapshot/candidate identity
status
cursor_start
cursor_next
cursor_end
batch_target
last_checkpoint_at
last_committed_position
timing/RSS diagnostics
retry/error state
```

The worker claims the task once, processes bounded internal batches, and checkpoints progress after each safe commit.

## Execution Semantics

Each component implements a cursor executor:

```text
while task has remaining range and budgets allow:
  choose next internal batch
  execute one safe write unit
  validate or count-check that unit
  commit output
  update checkpoint to the committed end position
  heartbeat task lease
  adjust batch size from timing/RSS
```

On restart, the worker resumes from `last_committed_position`.

The invariant is simple and strict:

> A checkpoint may only advance after all output before that position is committed and safe to treat as complete.

## Why This Is Better

- Fewer queue rows.
- Fewer claim/select cycles.
- Progress is understandable: "posting 42% complete" instead of "pending grew from splitting".
- ETA becomes more stable.
- Adaptive batch sizing becomes natural.
- Crashes resume from the last safe checkpoint without needing thousands of child rows.
- The worker can keep small internal batches for DuckDB safety while avoiding one manifest row per batch.

## Risks

Cursor/checkpoint execution is more invasive than coalescing.

The hard parts:

- ensuring idempotent output writes per cursor range
- proving checkpoint correctness across crash/restart
- handling partial component outputs without promoting inconsistent snapshots
- preserving operator diagnostics and repair visibility
- avoiding hidden long transactions
- supporting components whose output keys are not simple article ranges

Because of those risks, this should be designed and landed component-by-component, not as a broad rewrite.

## Data Model

Add a task/checkpoint table separate from the existing chunk manifest table, for example:

```text
app.review_rebuild_task
app.review_rebuild_task_checkpoint
```

The exact schema should be finalized during implementation, but it needs:

- stable task identity
- request identity
- component
- project/snapshot/candidate identity
- cursor type
- cursor JSON or typed range fields
- status
- lease owner/expiry
- retry counters
- latest timing diagnostics
- latest checkpoint position
- output count/byte counters
- repair metadata

Avoid stuffing the whole model into untyped JSON if typed fields are needed for claim ordering and repair.

## Component Cursor Types

Start with article-range cursor components:

- `posting`
- `search`
- `payload`
- `display`
- status lanes if their source ordering is stable

Defer components whose natural unit is not a simple article range until the model is proven.

Possible cursor shapes:

- article ordinal/range
- selected-import article range
- source partition + offset
- prompt/config range
- summary partial partition

## Phase 0 - Design And Parity Harness

Before replacing runtime behavior, build a parity harness:

- run existing chunk executor for a small request
- run cursor executor for the same component/range into an isolated candidate identity or test table
- compare output counts and stable checksums
- compare diagnostics

This prevents the cursor rewrite from becoming a correctness gamble.

## Phase 1 - Read-Only Planner And Diagnostics

Add a planner that can say:

- which cursor tasks would be created for a request
- expected ranges
- expected batch target
- estimated output fan-out
- expected checkpoint count

Do not execute it yet. Log or expose it behind a debug command/test only.

Acceptance:

- planner output matches existing admission chunks for covered components
- planner explains why each cursor range exists
- no runtime behavior change

## Phase 2 - One Component Behind A Flag

Pick one high-overhead, low-risk component from live timing. Likely candidate after more data:

- `posting` if output range idempotency is straightforward
- otherwise `search` if title-search writes are already well isolated and bounded

Run behind an opt-in env flag:

```text
FORSKA_REVIEW_SERVING_REBUILD_CURSOR_COMPONENTS=posting
```

Acceptance:

- same output as chunk executor
- resumes correctly after forced restart
- retries only the uncheckpointed internal batch
- timing improves mainly by reducing claim/select/finalize overhead
- no RSS regression

## Phase 3 - Task-Level Claiming

Replace many child chunk claims with one task claim:

- claim task
- process internal batches until budget/time/RSS cap
- release or heartbeat task
- next wake resumes same task or another eligible task

Important: the task must yield voluntarily after a bounded time budget so the owner stays responsive.

Acceptance:

- API/owner readiness stays true during long tasks
- watchdog/restart still works
- stale lease repair can recover a task left mid-range

## Phase 4 - Snapshot Finalization Integration

Snapshot finalization must understand cursor tasks:

- a component is complete only when its tasks have reached terminal checkpoints
- partial outputs must not be promoted
- repair paths must detect and rebuild corrupted cursor-managed output tables

Acceptance:

- candidate manifests do not become ready early
- finalization works after restart
- repair preserves evidence and can reset/replay cursor tasks

## Phase 5 - Migrate More Components

Migrate components one at a time, using timing evidence:

1. components with high queue overhead and simple idempotent ranges
2. components with SQL-native range writes
3. summary/finalization only after partial-output semantics are clean

Keep the chunk manifest executor as fallback until cursor-managed components have passed live gates on large projects.

## Testing Requirements

Focused tests:

- checkpoint advances only after successful commit
- restart resumes from checkpoint
- failed internal batch does not skip rows
- stale lease recovery reclaims the task
- finalization blocks incomplete cursor tasks
- diagnostics include checkpoint and internal batch timing
- cursor executor output matches chunk executor output

Suggested commands:

```bash
bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts
bun test src/server/workers/reviewServingProjectorWorker.test.ts -t "rebuild"
bun test src/server/reviewServing/reviewServingProjectorService.test.ts
bun run lint
```

Live gate for each migrated component:

- 3001/3002/3003 readiness true during execution.
- affected project `lastProgressedAt` advances.
- failed/blocked/quarantined/expired counts stay clean.
- RSS remains under cap or supervised restart behaves as designed.
- no fresh DuckDB OOM/fatal/index corruption markers.
- timing logs show lower queue overhead per completed output range.

## Rollout Strategy

1. Land planner and tests with no runtime behavior change.
2. Land one cursor-managed component behind a disabled-by-default flag.
3. Run parity tests and a staging/live copy benchmark.
4. Enable for one component on maintenance only.
5. Keep fallback to chunk manifests until multiple large-project rebuilds complete.
6. Remove chunk-manifest execution for that component only after evidence shows the cursor path is safer and faster.

## Relationship To Near-Term Plan

Adaptive coalescing is still worth doing first. It is smaller, safer, and directly improves the current live bottleneck.

Cursor/checkpoint execution is the long-term replacement when we want to stop modeling every internal work bite as a durable queue row. It should reuse the same timing, RSS, and repair lessons from PR #129 and the coalescing work.
