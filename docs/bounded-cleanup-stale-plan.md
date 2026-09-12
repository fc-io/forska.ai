# Bounded Cleanup-Stale Plan

Date: 2026-09-11

Context commit when written: `e9303bf3` (`fix judgment job refill stalls`)

Updated after reviewing additional 2026-09-11 work:

- `e9d40d0f` (`fix SGLang judgment job recovery metrics`)
- local request-attempt closeout recovery work in progress

## Goal

Make `judgments-jobs-cleanup-stale` cooperative. It should clean old judgment
job state without monopolizing the maintenance worker, blocking queue refill,
or making a running job look stuck.

The desired behavior is:

- cleanup makes steady progress in small bounded slices;
- `add-to-queue`, import, provider telemetry, and LLM-status ingestion still get
  turns while cleanup backlog exists;
- cleanup backlog is visible in diagnostics instead of appearing as a silent
  stalled cron;
- low-memory mode remains useful at `6400MiB`;
- no live recovery path silently deletes evidence or weakens storage safety.

## Triggering Observation

During live investigation on 2026-09-11, the admin unassessed-count route looked
slow, but the count endpoint itself was not the primary blocker:

- cold `GET /api/judgmentsjobs-unassessed-count` calls were roughly
  `0.4s-1.15s`;
- warm cached calls were roughly `9ms-112ms`;
- the count was large, around `544,684` unassessed articles;
- the job health endpoint reported `progressState=blocked_import`,
  `blockedReason=stale_import`, `ready=75`, `running=0`, `active=0`;
- cron diagnostics showed `judgments-jobs-cleanup-stale` still `running`, while
  `judgments-jobs-add-to-queue` and import ticks were skipping;
- the maintenance process was burning CPU inside DuckDB scan work.

That points to a broader scheduler/control-plane issue: cleanup can run long
enough that operational judgment work does not get a fair turn.

## Commit Impact Review

Today's relevant work does not change the plan direction, but it adds
implementation constraints.

`e9303bf3` already changed the import latch from a simple boolean into a
stale-aware activity record. After `JUDGMENTS_IMPORT_STALE_AFTER_MS`, operational
work can ignore a stuck import latch instead of letting one stale import run
block `add-to-queue` and judging indefinitely. Bounded cleanup should follow the
same principle:

- cleanup run state should have a run id, start time, running duration, stale or
  over-budget flag, and budget-exhausted result;
- a stale cleanup run marker must not permanently block queue refill, import,
  provider telemetry, LLM status, or judging;
- stale cleanup state should be loud in diagnostics, but it should not be
  reported as a provider failure or generic `stale_import` without cleanup
  context;
- tests should preserve the `e9303bf3` invariant that stale import/refill
  latches do not stop operational work forever.

`e9d40d0f` improves SGLang/provider recovery metrics and adds persisted prompt
stats to the job route. That makes diagnosis better, but it also means cleanup
diagnostics should avoid adding new heavy route-time scans. Prefer exposing
cleanup state already tracked by the cron/owner rather than computing broad
backlog counts on every admin route read.

The current request-attempt closeout recovery work in progress adds another
mutable DuckDB table in the same family of indexed-table hazards. It does not
change `cleanup-stale` directly, but it reinforces the DuckDB-side cleanup rule:
closeout reconciliation and provider-admission cleanup must be bounded before
query execution and should avoid broad scans or large `RETURNING` rowsets.

## Current Code Shape

Relevant code:

- `src/server/cron/judgmentsJobsOperationalCron.ts`
  - mounts `cleanupStaleQueueCron`;
  - records cron start/success/failure;
  - calls `judgmentsJobsCleanupStale()` as one unbounded unit.
- `src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts`
  - performs several DuckDB and SQLite cleanup/recovery steps sequentially;
  - includes `pruneVisibilityAckedRetentionUntilStable`, which loops until one
    draining job has no more retention rows to prune;
  - runs DuckDB-side cleanup and reconciliation steps after local SQLite work.
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
  - already exposes row-bounded helpers such as
    `pruneVisibilityAckedRetention({maxRows})`, but the caller can repeatedly
    invoke them until stable.

The important distinction is that some lower-level helpers are bounded, but the
top-level cleanup tick is not bounded by elapsed time, total rows, total jobs,
or total DuckDB work.

## Non-Goals

- Do not disable cleanup permanently.
- Do not make cleanup purely manual.
- Do not skip safety repairs that prevent corrupted or orphaned job state from
  accumulating.
- Do not make stale leases live forever.
- Do not hide the issue by only changing admin UI polling.
- Do not rely on process restart as the normal way to break a long cleanup run.
- Do not add broad DuckDB scans with a timer around them and call them bounded.
  Bounds must happen before expensive candidate discovery where possible.

## Design Principles

1. Cleanup is operational work, not exclusive maintenance.

   It belongs in the low-memory-safe control plane, so each tick must be short.

2. Every cleanup step needs a budget.

   Budgets should include at least a deadline and row/job limits. Some steps
   also need query-count limits.

3. A timeout is a yield, not a failure.

   Hitting the budget should record `partial` or `budget_exhausted` state and
   resume on the next cron tick.

4. Avoid recursive "until stable" loops.

   A loop that keeps deleting 1,000 rows until no rows remain is still
   unbounded. It should become "delete at most N rows or M batches this tick."

5. Diagnostics must name the current step.

   Operators should see whether cleanup is spending time on SQLite retention,
   stale outbox claims, DuckDB lease reconciliation, provider telemetry
   pruning, missing SQLite drain finalization, or another step.

6. Foreground and dispatch work should not wait for perfect cleanup.

   A large cleanup backlog should degrade cleanup freshness, not stop prompt
   admission or import.

7. Stale cleanup activity is a diagnosis, not a global lock.

   If cleanup exceeds its budget or leaves a stale running marker, the owner
   should surface that state and allow safe operational crons to continue. Do not
   replace the old stale import blocker with a new stale cleanup blocker.

## Proposed Runtime Contract

For each `cleanup-stale` cron tick:

- total wall-clock budget: start with `2s-5s`;
- total SQLite retention rows: start with `1,000-5,000`;
- total draining jobs scanned: bounded, for example `5-20`;
- total repair actions: bounded, for example `1-3`;
- total DuckDB cleanup/reconciliation queries: bounded by step and skipped when
  deadline is too close;
- a tick that reaches budget exits cleanly and records partial progress;
- the next tick resumes from persisted state or naturally rescans a bounded
  prefix.

The exact numbers should be tuned against current-DB evidence. The key invariant
is that a cleanup tick cannot occupy the maintenance owner indefinitely.

## Proposed Implementation

### 1. Add a Cleanup Budget Type

Introduce a small budget object passed through the cleanup call stack:

```ts
type CleanupStaleBudget = {
  deadlineMs: number
  maxDrainingJobs: number
  maxDuckdbSteps: number
  maxRepairActions: number
  maxSqliteRetentionBatches: number
  maxSqliteRetentionRows: number
  now: Date
  serverJobId: string
}
```

Add helpers:

```ts
const hasCleanupBudgetRemaining = (budget: CleanupStaleBudget) => Date.now() < budget.deadlineMs
const getCleanupBudgetRemainingMs = (budget: CleanupStaleBudget) => Math.max(0, budget.deadlineMs - Date.now())
```

Each cleanup substep should check the budget before starting expensive work and
after every bounded batch.

### 2. Return Structured Cleanup Results

Have `judgmentsJobsCleanupStale` return a summary instead of `void`:

```ts
type CleanupStaleResult = {
  completed: boolean
  exhaustedBudget: boolean
  steps: Array<{
    durationMs: number
    name: string
    rowsChanged?: number
    skippedReason?: string
    status: 'completed' | 'partial' | 'skipped' | 'failed'
  }>
}
```

The cron can still record normal success when cleanup yields cleanly. A partial
result is not an error.

### 3. Track Cleanup Run Activity Explicitly

Mirror the stale-aware import latch pattern from `judgmentsJobsCronState.ts`.
Cleanup should record enough state for the owner and admin diagnostics to tell
these apart:

- no cleanup currently active;
- cleanup active and within budget;
- cleanup yielded after exhausting this tick's budget;
- cleanup run marker is stale or over budget;
- cleanup failed with a real error.

Suggested state:

```ts
type CleanupStaleCronActivity = {
  budgetMs: number
  currentStep: string | null
  exhaustedBudget: boolean
  runId: string | null
  runningForMs: number | null
  shouldStartAnotherCleanupRun: boolean
  stale: boolean
  startedAtMs: number | null
}
```

This state should be independent from the import latch. A stale cleanup marker
may prevent a duplicate cleanup run, but it must not by itself block import,
`add-to-queue`, provider telemetry, LLM status, or judging.

### 4. Remove Unbounded Retention Loops

Replace `pruneVisibilityAckedRetentionUntilStable` with a bounded loop:

- process at most `maxSqliteRetentionBatches` batches per job;
- process at most `maxSqliteRetentionRows` total rows per tick;
- stop when deadline is near;
- record remaining work as backlog, not failure.

The existing `pruneVisibilityAckedRetention({maxRows})` helper is a good base,
but the top-level caller must stop after a fixed number of batches.

### 5. Bound Recursive Job Walks

Several helpers recurse through job IDs:

- `recoverDrainingQueueRows`
- `repairOrphanedDrainingJobs`
- `repairUnavailableRequestAttemptDiagnostics`
- `pruneDrainingVisibilityAckedRetention`
- transient-lock and OOM recovery helpers

Change the top-level cleanup scheduler so each helper receives a sliced list or
a shared budget. It should never process every known job if the list is large.

Recommended approach:

- collect candidate IDs as before, but slice per category;
- process high-safety repairs first;
- carry remaining work to the next tick naturally through the underlying state;
- add explicit counters for "candidate jobs seen" and "candidate jobs handled."

### 6. Bound DuckDB-Side Cleanup Steps

DuckDB steps need special care because the expensive work can happen before any
JavaScript timeout check can run.

Audit these steps first:

- `getDrainingSqliteJobIds`
- `getMissingLocalSqliteDrainingJobIds`
- `getRecoverableOomQuarantinedJobIds`
- `getTransientLockedQuarantinedSqliteJobIds`
- `getOrphanedDrainingJobIds`
- `finalizeMissingLocalSqliteDrainingJobs`
- `pruneJudgmentProviderTelemetryHistorySamples`
- `finalizeDrainingJobs`
- `reconcileProviderAdmissionLeasesForDurableCloseout`
- `deleteDrainedJobs`
- any request-attempt closeout backfill or closeout reconciliation that becomes
  part of cleanup after the `0232` request-attempt closeout recovery work

For each DuckDB query:

- make sure candidate selection has an explicit `LIMIT`;
- avoid `DELETE ... RETURNING id` when only a count is needed;
- prefer `RETURNING count(*)` style evidence only where supported and cheap, or
  follow with a bounded count over affected keys;
- use workload contexts with timeouts where available;
- if a query can scan a large compressed string table, add a narrower predicate,
  a cursor, or a separate materialized cleanup candidate list before shipping.

### 7. Add Cleanup Runtime Diagnostics

Expose diagnostics through existing cron runtime state and job health payloads:

- current cleanup step name;
- step started at;
- running duration;
- last completed step;
- last partial/yield reason;
- rows/jobs processed in last tick;
- backlog indicators where cheap to compute;
- last error, if any.

The admin job health page should distinguish:

- `cleanup_stale_running_short`
- `cleanup_stale_budget_exhausted`
- `cleanup_stale_backlog`
- `cleanup_stale_stuck_or_over_budget`

This prevents a generic `blocked_import/stale_import` from being the only clue.

Route and admin diagnostics should reuse this tracked cleanup state. Avoid
adding broad per-request route queries only to compute cleanup backlog numbers.

### 8. Add a Watchdog for Over-Budget Cleanup

If `cleanup-stale` is still marked running far past the intended budget:

- log a rate-limited warning with the current step name and duration;
- mark diagnostics as over-budget;
- do not start a second cleanup run;
- allow other operational crons to continue when safe.

The watchdog should not kill the process by default. Killing can discard useful
evidence and may interrupt a DuckDB mutation. Process restart remains an
operator action unless there is a separate, proven safe owner-restart path.

## Suggested Implementation Slices

### Slice A: Instrument and Bound Local SQLite Retention

- Add `CleanupStaleBudget` and `CleanupStaleResult`.
- Replace `pruneVisibilityAckedRetentionUntilStable`.
- Add step-level diagnostics for SQLite retention cleanup.
- Tests:
  - cleanup with a large retention backlog yields after configured batches;
  - a second tick continues cleanup;
  - partial cleanup still records cron success, not failure;
  - over-budget cleanup activity is reported as stale/partial cleanup state;
  - active jobs still permit queue refill/import ticks after cleanup yields.

### Slice B: Bound Job-List Repairs

- Slice candidate job IDs per category.
- Bound transient lock recovery, OOM recovery, orphaned draining repair, and
  unavailable request-attempt repair.
- Tests:
  - many candidate jobs are processed across ticks;
  - repair action limits are respected;
  - lease errors remain non-fatal;
  - non-lease errors still fail the cron step.

### Slice C: Bound DuckDB Cleanup and Reconciliation

- Audit and tune each DuckDB query.
- Remove or narrow any broad scan discovered by profiling.
- Add workload contexts/timeouts where missing.
- Tests:
  - telemetry prune does not use broad `RETURNING` when no rows are old;
  - provider admission lease reconciliation limits probes;
  - missing SQLite drain finalization limits job candidates;
  - diagnostics expose the active DuckDB cleanup step.

### Slice D: Admin and Health Surface

- Include cleanup step and budget state in `/api/duckdb_owner_connections`.
- Include relevant cleanup backlog/over-budget status in job health.
- Update admin copy only enough to make the state understandable.
- Tests:
  - health payload distinguishes stale import caused by cleanup backlog from
    provider/runtime failures;
  - SGLang endpoint recovery/probing metrics remain provider diagnostics, not
    cleanup diagnostics;
  - owner diagnostics show active/partial cleanup state.

## Verification Plan

Focused tests:

- `bun test src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts --timeout 120000`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts --timeout 120000`
- `bun test src/server/cron/judgmentsJobsCronState.test.ts src/server/cron/judgmentsJobs.test.ts --timeout 120000`
- any affected route/diagnostic tests for job health and owner connections.

Static checks:

- focused ESLint for touched cron/service/route files;
- `git diff --check`.

Live gate before merge:

1. Start the normal split stack at the intended low-memory cap.
2. Confirm API and maintenance owner readiness.
3. Create or identify a cleanup backlog large enough to exercise yielding.
4. Confirm `cleanup-stale` reports partial progress and yields.
5. Confirm `add-to-queue`, import, provider telemetry, and LLM status continue
   to tick while cleanup backlog remains.
6. Confirm stale cleanup state does not regress the stale-aware import latch
   behavior introduced in `e9303bf3`.
7. Confirm a real current-DB judgment job moves from ready/import-blocked state
   to active/running or otherwise reports a truthful non-cleanup blocker.
8. Confirm the unassessed-count route remains responsive under cleanup load.

Do not accept readiness-only evidence. The live gate must show real progress or
a truthful, correctly attributed blocker.

## Performance Notes

- Timers alone do not protect against a single broad DuckDB query. Candidate
  discovery must be bounded before the query starts.
- `LIMIT` after an expensive scan is not enough. Use physical evidence or
  profiling on current DB data for any query suspected of scanning large mart or
  telemetry tables.
- Avoid `RETURNING` large rowsets from cleanup deletes. If diagnostics only need
  counts, return counts.
- Keep cleanup batch sizes small in low-memory mode. A higher-memory profile may
  use larger budgets, but the low-memory contract should remain valid.

## Risks

- Cleanup backlog may persist longer. This is acceptable if it is visible and
  operational work continues.
- Some job finalization may be delayed by several ticks. The UI should show this
  as cleanup backlog, not as provider failure.
- Poorly bounded DuckDB candidate queries can still monopolize the owner. Each
  DuckDB step needs separate review and evidence.
- Too-small budgets can create permanent cleanup debt. Diagnostics should show
  accumulated debt so budgets can be tuned.

## Recommended Defaults

Initial conservative defaults:

- total cleanup tick budget: `3000ms`;
- SQLite retention batch size: keep `1000`;
- max retention batches per tick: `1-3`;
- max repair actions per category per tick: `1-3`;
- max candidate jobs per category per tick: `5-20`;
- warn when a cleanup run exceeds `2x` the configured budget;
- treat budget exhaustion as a successful partial cleanup tick.

Tune these from current-DB evidence, not guesses.

## Relationship to Unassessed Count Route

The unassessed-count route should still be improved, but it is secondary.

Recommended route improvements:

- align cache TTL with UI polling, for example `45s-60s`;
- add in-flight dedupe so concurrent requests share one count query;
- later, move the count to a precomputed summary if it remains hot.

Those changes reduce admin page pain. They do not fix cleanup monopolizing the
operational control plane, so they should not be treated as a substitute for
bounded `cleanup-stale`.
