# Low-Memory Maintenance Cron Split Plan

Date: 2026-09-10

Context commit when written: `d50b09c6` (`Fix Arrhenius GPU telemetry polling`)

## Goal

Make the intended low-memory DuckDB owner profile useful as a normal operating
mode. A maintenance owner capped around `6400MiB` should still keep judgment
jobs, provider runtime telemetry, and `/admin/llm` observability alive while it
continues to defer or bound memory-heavy maintenance work.

Raising the maintenance cap above `8192MiB` is an acceptable local workaround,
but it is not the durable fix. The product should work at the intended
low-memory cap.

## Current Problem

`src/server/serverMain.ts` currently treats low-memory owner mode as a single
maintenance-cron gate:

- `lowMemoryMaintenanceDuckdbLimitMiB = 8192`
- `shouldDeferMaintenanceCronsForLowMemoryOwner()` returns true when
  `DUCKDB_MEMORY_LIMIT <= 8192MiB`
- `shouldMountMaintenanceCrons` then disables the entire maintenance cron route
  bundle

When that happens, `serverMain` still mounts the import-only judgment cron, but
it does not mount `src/server/cron/judgmentsJobs.ts`, which currently contains:

- `judgments-jobs-add-to-queue`
- `judgments-jobs-import-judgments`
- `judgments-jobs-cleanup-stale`
- `judgments-jobs-sample-provider-telemetry`
- `judgments-jobs-check-llm-status`

That means low-memory mode disables required control-plane work:

- A job can remain `running` while no prompt work is admitted into the ready
  queue.
- A healthy SGLang runtime can be idle because the local queue is empty.
- Provider pages and job diagnostics can miss fresh runtime/provider samples.
- `/admin/llm` can show stale `app.llm_status` rows because status ingestion is
  not running.
- Operators see a confusing combination: remote `/v1/models` and `/metrics`
  are healthy, but the app looks stale or idle.

The bad coupling is not that low-memory mode exists. The bad coupling is that
"low memory, defer heavy DuckDB maintenance" also means "low memory, stop the
judgment scheduling and observability control plane."

## Non-Goals

- Do not remove the low-memory cap or make `16GB` the required default.
- Do not re-enable every maintenance cron under low memory.
- Do not make heavyweight review-serving projector work unbounded again.
- Do not hide this with quieter logs alone.
- Do not duplicate import timers when both operational and judging cron routes
  are mounted.

## Desired Runtime Contract

At `DUCKDB_MEMORY_LIMIT=6400MiB`:

- The maintenance owner still runs startup recovery and migrations.
- Judgment SQLite outbox import remains enabled.
- Queue refill runs with explicit small bounds.
- Provider telemetry sampling runs with short timeouts and non-overlap guards.
- LLM status ingestion runs with short timeouts and non-overlap guards.
- Cleanup-stale runs at low frequency and skips during exclusive DuckDB work.
- Heavy cron groups remain deferred or separately bounded.
- Admin surfaces can say which cron classes are active/deferred and why.

At `DUCKDB_MEMORY_LIMIT > 8192MiB`:

- The full current maintenance set can mount, subject to existing role gates.

## Proposed Design

### 1. Split Cron Classes Explicitly

Replace the single `shouldMountMaintenanceCrons` decision with separate
decisions:

- `shouldMountOperationalJudgmentCrons`
- `shouldMountHeavyMaintenanceCrons`
- `shouldMountJudgingCrons`

Suggested shape in `serverMain`:

- `shouldMountOperationalJudgmentCrons`
  - true when mutation work is enabled and the current role can mount
    maintenance crons
  - not disabled merely because DuckDB memory is `<=8192MiB`
- `shouldMountHeavyMaintenanceCrons`
  - true only when mutation work is enabled, the role can mount maintenance
    crons, and `shouldDeferMaintenanceCronsForLowMemoryOwner()` is false
- `shouldMountJudgingCrons`
  - keep the existing role behavior

Then wire routes roughly as:

- heavy maintenance routes:
  - `fullTextJobsCron`
  - `fullTextConversionJobsCron`
  - `nvidiaSmiCron` if it belongs with heavy maintenance, or a separate
    diagnostics class if it should remain lightweight
- operational judgment routes:
  - queue refill
  - import judgments
  - cleanup stale judgment state
  - provider telemetry sampling
  - LLM status ingestion
- judging routes:
  - existing judging-worker loop routes
- import-only routes:
  - only for roles that need import and are not already mounting the
    operational judgment route group

### 2. Refactor `judgmentsJobs.ts` Into Smaller Modules

`src/server/cron/judgmentsJobs.ts` currently mixes all judgment maintenance
timers in one exported `judgmentsJobsMaintenanceCron`.

Recommended refactor:

- Keep `src/server/cron/judgmentsJobsImportCron.ts` as the single source of
  truth for import.
- Add `src/server/cron/judgmentsJobsOperationalCron.ts`:
  - imports and mounts `judgmentsJobsImportCron`
  - mounts add-to-queue
  - mounts cleanup-stale
  - mounts provider telemetry sampler
  - mounts LLM-status ingestion
- Keep `judgmentsJobsMaintenanceCron` as either:
  - a compatibility alias for `judgmentsJobsOperationalCron`, if there are no
    heavier judgment crons today, or
  - a composition of operational judgment crons plus future heavier judgment
    maintenance.

The important part is that `serverMain` can mount operational judgment crons
under low memory without mounting unrelated heavy maintenance.

### 3. Preserve Low-Memory Bounds Inside Operational Crons

Do not simply turn everything back on and hope it stays cheap.

`add-to-queue` is a reasonable low-memory candidate because it already has
useful bounds:

- one SQLite scan window per tick
- max prompt candidate limit
- ready-target refill logic
- lease and exclusive-work guards
- overlap prevention

Make those constraints visible and testable:

- Name the low-memory candidate/batch limits explicitly.
- Assert that low-memory mode does not increase scan windows or candidate
  counts.
- Keep `hasActiveDuckdbExclusiveWork()` admission checks.
- Keep `judgmentsJobsCronState.isImportingJudgments` coordination.

Telemetry and status ingestion should also stay bounded:

- short fetch timeouts
- non-overlap guards
- rate-limited warnings
- no broad product-review scans
- no retry loops inside a single cron tick

### 4. Make Admin Diagnostics Honest

The admin pages should not require log archaeology to explain this state.

Add a small runtime diagnostics model that exposes cron activation by class:

- `operationalJudgmentCrons.active`
- `heavyMaintenanceCrons.active`
- `judgingCrons.active`
- `importOnlyCrons.active`
- `deferred.reason`
- `duckdbMemoryLimit`
- `lowMemoryThresholdMiB`
- `lastTickAt` and `lastSuccessAt` for the important operational crons

Good places to surface this:

- `GET /api/duckdb_owner_connections`
- admin job detail diagnostics
- provider detail diagnostics
- `/api/llmstatus` response metadata

UI copy should distinguish:

- remote runtime missing
- remote runtime healthy but idle
- no eligible work
- queue refill cron deferred
- LLM-status ingestion stale/deferred
- provider telemetry stale/deferred

### 5. Reduce Low-Memory Startup Log Noise

The repeated line:

```text
[duckdb] skipped proactive startup mutation preflight under low-memory runtime
```

is expected under the low-memory profile, but it is too noisy when the projector
recycles DuckDB frequently.

Change it to one of:

- once per process/database/memory limit
- rate-limited to a long window
- file-only debug while leaving true blockers as warnings/errors

Do not soften these logs:

- WAL repair blocks
- checkpoint/replay failures
- startup repair blocks
- owner crashes/restarts
- failed DuckDB migration

## Implementation Slices

### Slice 1: Classification And Tests

Add explicit cron-class helpers and tests without changing behavior yet.

Tasks:

- Add named decisions in `serverMain` for operational judgment and heavy
  maintenance cron classes.
- Keep current mounting behavior during this slice if needed.
- Add string/structure guard tests in `src/server/routes/duckdbRouteGuardrails.test.ts`.
- Add cron composition tests in `src/server/cron/judgmentsJobs.test.ts`.

Acceptance:

- Tests prove the intended classes exist and import lazily.
- No cron timer starts at module import time when disabled.
- Import-only behavior cannot duplicate the import timer.

### Slice 2: Operational Judgment Crons At Low Memory

Change behavior so `6400MiB` mounts operational judgment crons, but not heavy
maintenance crons.

Tasks:

- Create or refactor `judgmentsJobsOperationalCron`.
- Mount it when the current role is maintenance-capable, mutation work is
  enabled, and low-memory mode is active.
- Keep full-text/conversion/heavy maintenance deferred at `<=8192MiB`.
- Keep judging-worker routes unchanged.
- Ensure import is mounted exactly once.

Acceptance:

- At `6400MiB`, tests observe add-to-queue, import, cleanup-stale, telemetry,
  and LLM-status cron names.
- At `6400MiB`, tests do not observe full-text/conversion heavy cron names.
- At `8193MiB`, tests observe the full maintenance set.

### Slice 3: Bounded Cron Behavior

Make the low-memory operational behavior explicitly safe.

Tasks:

- Add tests that `add-to-queue` keeps its low candidate/scan bounds.
- Add tests that telemetry/status skip during exclusive DuckDB work.
- Add tests that overlapping provider telemetry and add-to-queue runs do not
  stack.
- Add failure logging tests for rate-limited, non-terminal cron failures.

Acceptance:

- Low-memory control-plane crons cannot create unbounded batch work.
- Cron failure in telemetry/status does not stop later ticks.
- Exclusive work pauses operational crons instead of contending with repair or
  migration work.

### Slice 4: Admin Visibility

Expose cron-state metadata so the UI tells the truth.

Tasks:

- Add backend cron-class diagnostics.
- Add latest tick/success/staleness metadata for add-to-queue, telemetry, and
  LLM status ingestion.
- Surface stale/deferred reasons in admin jobs and `/admin/llm`.
- Prefer "runtime healthy but idle/no eligible work" over "missing provider"
  when runtime probes are healthy.

Acceptance:

- `/admin/llm` can explain when rows are old because ingestion is inactive.
- Admin job detail can distinguish `noReadyWork` from disabled queue refill.
- Provider pages can distinguish stale cached telemetry from live probe health.

### Slice 5: Log Cleanup

Reduce expected low-memory noise after the behavioral fix lands.

Tasks:

- Rate-limit or once-per-process the skipped proactive preflight message.
- Include memory limit, threshold, process role, and database path in the first
  log.
- Keep fatal repair and WAL evidence logs loud.

Acceptance:

- Normal low-memory projector recycle loops do not spam terminal output.
- A real startup repair block remains obvious and actionable.

## Verification Plan

Focused tests:

```bash
bun test src/server/routes/duckdbRouteGuardrails.test.ts
bun test src/server/cron/judgmentsJobs.test.ts
bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts
bun test src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.test.ts
bun test src/server/routes/LlmStatusRoutes.test.ts src/server/routes/JudgmentsJobsRoutes.test.ts
bun run lint
git diff --check
```

Add or adjust tests as the implementation settles:

- low-memory route-mount test for `6400MiB`
- full-maintenance route-mount test for `8193MiB`
- import-not-duplicated test
- queue refill still bounded test
- telemetry/status stale diagnostics tests

Live current-DB gate:

1. Start the stack with the intended low-memory cap:

   ```bash
   BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT=6400MiB bun run dev:start
   ```

2. Confirm readiness:

   - API ready
   - maintenance/DuckDB owner ready
   - judge worker ready when judging is enabled

3. Confirm remote provider health:

   - `/v1/models` responds
   - `/metrics` responds and parses

4. Confirm low-memory operational crons run:

   - fresh `app.llm_status` row appears after a status interval
   - provider telemetry history receives a fresh sample for a running job
   - queue refill either admits ready rows or reports a truthful "no eligible
     work" state with the cron active

5. Confirm heavy work remains bounded/deferred:

   - no full-text/conversion heavy timers run merely because operational crons
     are active
   - review-serving projector still uses low-memory batch/RSS limits

6. Confirm progress where applicable:

   - if the target job has eligible prompts, ready/claimed/judged counters move
   - if the job has no eligible prompts, admin diagnostics say so without
     claiming provider failure

7. Confirm cleanup:

   - stop stack
   - ports 3001/3002/3003 clear
   - no stale primary owner lock or judge journal lock remains

## Rollout Notes

- This should be a normal code fix, not a local settings workaround.
- Keep `10GB`/`16GB` as emergency operator advice only.
- Backport to the stable release branch if `release/amber-mesa` remains the
  active user-facing branch.
- Update `TESTS.md` if new focused commands become part of the standard
  maintenance/WAL/judgment verification set.

## Residual Risks

- `add-to-queue` writes DuckDB state, so it must stay bounded and exclusive-work
  aware.
- Provider telemetry can become noisy if remote endpoints are slow or flapping;
  keep timeouts and rate-limited errors.
- UI staleness indicators can become misleading if they only look at cached
  rows; include cron activity and live runtime probe state.
- Full-text/conversion/Nvidia diagnostics may need their own classification if
  they are not all equally heavy.
