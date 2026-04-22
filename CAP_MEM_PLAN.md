# Cap Memory Recovery Plan

## Goal

- Start DuckDB at the highest safe active rung at or below the configured ceiling on the first open.
- Keep the writer process alive through DuckDB OOM pressure without requiring a manual restart.
- Step the embedded DuckDB memory cap down automatically until work fits or reaches a hard floor.
- Stop only the offending heavy work when the floor is exhausted, while keeping the writer alive and non-DuckDB API flow available.
- Use a controlled DuckDB restart gate so DuckDB-backed work waits cleanly during cap step-down instead of racing a runtime close.

## Current Signal

- The `primary` worker crashes Bun when the writer is allowed to use more than about `6400MiB` on this macOS machine.
- A worker can still boot with a configured DuckDB ceiling above the stable rung, so the process can die before any recovery path runs.
- `projectMartRefreshWorker` already turns project-level errors into `failed` state, but failed rows are immediately claimable again and can thrash.
- Claimed large rebuild work already persists generic `failed` state, but failed rows are immediately claimable again and DuckDB OOM is not treated as a first-class recovery condition.
- `duckdbService.ts` caches `DUCKDB_MEMORY_LIMIT` at service startup, so lowering the cap requires closing and reopening the embedded DuckDB runtime in-process.
- The current DuckDB close barrier drains append and background work, but a cap step-down path also has to serialize with the main DuckDB queue or it can interrupt unrelated queued work.

## Core Decision

- Treat DuckDB OOM as a retryable operational state, not a generic exception.
- Keep the configured cap as the ceiling, derive a process-local active cap from a fixed ladder, and use that active cap for both the first DuckDB open and later restarts.
- The initial active cap is the highest rung at or below the configured ceiling. If the ceiling falls between rungs, round down to the next lower rung instead of opening above the ceiling.
- Keep one shared process-local active-cap source of truth for DuckDB runtime, mart refresh admission, large rebuild tuning, and worker diagnostics.
- Use `failed` as the retryable-with-cooldown state and `paused` as the terminal auto-retry stop, with explicit operator resume paths for both mart refresh and large rebuild state.
- Use one shared project-local retry-after cooldown of `5m`.
- Step the active runtime cap down through a fixed ladder:
  - `6400MiB`
  - `4096MiB`
  - `3072MiB`
  - `2048MiB`
  - `1536MiB`
  - `1024MiB`
- Use a controlled DuckDB restart gate for cap step-down that serializes through the main queue, drains append and background lanes, and keeps non-DuckDB API flow alive while DuckDB-backed work waits.
- Trip the writer-wide heavy-work breaker when the governor records `3` DuckDB OOM events inside `60s` and those events either lack project context or span more than one project or heavy component. Hold the breaker for `5m`.
- Do not persist step-downs into `app.user_config`; runtime recovery stays process-local and the configured ceiling remains unchanged.
- Reuse existing DB state to block immediate retries instead of adding a new schema table.

## Recovery Rules

1. On worker startup:
   - Derive the active startup rung from the configured ceiling before the first `DuckDBInstance.create(...)`.
   - Open the embedded DuckDB runtime with the derived active cap, not the raw configured ceiling.

2. On a project-local DuckDB OOM:
   - Lower the active runtime cap one rung.
   - Request a controlled in-process DuckDB restart that serializes behind the main DuckDB work queue, drains append and background queues, closes the embedded runtime, and lets it reopen lazily on the next query.
   - Keep the process and non-DuckDB API routes alive during that restart gate; DuckDB-backed work may wait briefly behind the restart instead of racing the close.
   - Mark the project refresh or large rebuild as failed with a `5m` retry-after cooldown.
   - Let the background loop continue and reclaim the work automatically after cooldown.
   - After cooldown expires, let that work re-enter the normal claim path behind non-failed claimable work, without adding a separate retry queue.

3. On repeated DuckDB OOM for the same project:
   - Keep stepping the runtime cap down until `1024MiB`.
   - Keep predictive limits aligned with the lower cap so large inline work is routed into safer paths earlier.

4. On DuckDB OOM at `1024MiB` for one project:
   - Transition that specific project refresh or rebuild to `paused`.
   - Leave a clear failure reason in DB state so the operator can inspect it, including the floor rung.
   - Require an explicit operator resume action through a normal API route; do not rely on manual DB edits.
   - Keep the writer process and unrelated work alive.

5. On DuckDB OOM outside a clear project context, or across multiple heavy components in a short window:
   - Trip a writer-wide heavy-work breaker after `3` qualifying OOM events inside `60s`.
   - Pause only heavy background loops for `5m`.
   - Keep the process alive and auto-resume heavy work after cooldown.

## Step 1. Add A Shared OOM Recovery Governor

Files:

- `src/server/utils/runtimeBootstrap.ts`
- `src/server/utils/duckdbOomGovernor.ts`
- `src/server/utils/duckdbService.ts`
- `src/server/utils/backgroundServerStack.ts`
- `src/server/utils/duckdbMemoryLimit.ts`
- `src/server/utils/startBackgroundWork.ts`

Changes:

- Add a shared `isDuckdbOutOfMemoryError(...)` helper.
- Add a process-local recovery governor that tracks:
  - configured cap ceiling
  - derived startup cap rung
  - current active cap rung
  - recent OOM events by component
  - recent OOM events by project when known
  - heavy-work breaker cooldown state
- Seed the governor during runtime bootstrap before `serverMain.ts` can call `migrateDuckdb()` or any other first DuckDB open, and have `duckdbService` read it for the first `DuckDBInstance.create(...)` instead of reading raw `process.env.DUCKDB_MEMORY_LIMIT`.
- Export a shared active-cap accessor so runtime decisions do not read `process.env.DUCKDB_MEMORY_LIMIT` directly.
- Keep the first version deterministic by storing the project cooldown (`5m`), breaker window (`60s`), breaker threshold (`3`), and breaker cooldown (`5m`) as small governor-owned constants.
- Add a controlled in-process DuckDB restart path that lowers the active runtime cap, serializes through the main DuckDB queue, drains append and background work, closes the embedded runtime, and lets it reopen lazily on the next query.
- Reuse that same restart gate for OOM step-down and fatal-runtime recovery so there is one close-and-reopen implementation.

Expected result:

- OOM handling becomes consistent across mart refresh, large rebuild, and other heavy writer paths.
- The first DuckDB startup already uses the safe rung at or below the configured ceiling.
- Memory step-down no longer requires restarting `bun run dev:server`.
- Cap step-down no longer races unrelated queued DuckDB work.

## Step 2. Reuse Existing DB State As Retry-After

Files:

- `src/server/services/projectMartRefreshStateService.ts`
- `src/server/services/projectMartLargeRebuildStateService.ts`
- related tests adjacent to those files

Changes:

- Reuse `lease_expires_at` as a retry-after timestamp for failed heavy work, but keep treating it as a live lease only when `refresh_status = 'running'`.
- Update claim logic so failed rows are claimable only when cooldown has expired.
- Keep `paused` rows out of automatic claim paths so floor-exhausted work stays stopped until an explicit operator action changes it.
- When cooldown expires, deprioritize failed work behind non-failed claimable work in the existing claim query instead of adding a separate retry priority queue.
- Keep this path simple by using status-aware ordering in the current claim query instead of mutating request timestamps or adding extra queue state just to reorder cooled-down failures.
- Add explicit mart-refresh pause and resume service methods so a floor-exhausted refresh can stop automatically and later resume without manual DB edits.
- Keep `last_error` explicit when the failure reason is DuckDB OOM and include the current cap rung plus retry or paused context.

Expected result:

- Project-local OOMs stop hot-looping immediately.
- Retry timing is visible in existing DB state without a schema migration.
- Recovery stays fair and predictable because fresh claimable work stays ahead of cooled-down retries.
- Paused mart refresh and large rebuild work both have explicit service-level recovery paths.

## Step 3. Make Mart Refresh Self-Healing

Files:

- `src/server/workers/projectMartRefreshWorker.ts`
- `src/server/utils/projectMartRefreshWorkerHeartbeat.ts`
- `src/server/routes/AdminInvestigateRoutes.ts`
- `src/server/workers/projectMartRefreshWorker.test.ts`

Changes:

- On OOM during project refresh, invoke the recovery governor instead of treating it like a generic failure.
- Attach a `5m` retry-after cooldown to the claimed project state before releasing the loop back to the heartbeat.
- When a project still OOMs at the floor rung, transition that refresh to `paused` with an explicit system-generated reason instead of leaving it in retryable `failed` state.
- Add an admin resume path for paused project refresh rows so floor-exhausted refreshes can be recovered without manual DB edits. Do not add a separate manual pause route in the first version.
- Restart the mart refresh loop automatically if it escapes, with cooldown-aware backoff.
- Keep the current low-memory routing behavior so large inline full refreshes move into large rebuild earlier at smaller cap rungs.

Expected result:

- Mart refresh no longer needs a manual server restart after an OOM.
- The same project does not immediately thrash the writer on reclaim.
- Floor-exhausted refreshes have an explicit operator recovery path.

## Step 4. Make Large Rebuild OOM-Aware

Files:

- `src/server/services/projectMartLargeRebuildRunner.ts`
- `src/server/services/projectMartLargeRebuildCyclesService.ts`
- `src/server/utils/projectMartLargeRebuildHeartbeat.ts`
- `src/server/utils/projectMartLargeRebuildTuning.ts`
- adjacent tests

Changes:

- On OOM in a claimed rebuild, route the existing failure path through the governor so the rebuild gets cooldown, cap step-down, and floor-aware pause behavior instead of only a generic failed retry.
- When a rebuild still OOMs at the floor rung, transition it to `paused` with an explicit system-generated reason instead of keeping it in retryable `failed` state.
- On retry, use the lower active cap rung to reduce rebuild aggressiveness:
  - lower `batchSize`
  - lower `maxCyclesPerWake`
  - keep poll interval reasonable to avoid tight thrash
- Leave `paused` semantics intact for operator-driven stops.

Expected result:

- Large rebuild work recovers automatically after cooldown when smaller batches can fit.
- Rebuilds that still fail at `1024MiB` stop locally instead of destabilizing the writer.

## Step 5. Add Predictive Admission Control

Files:

- `src/server/workers/projectMartRefreshWorker.ts`
- `src/server/utils/projectMartLargeRebuildTuning.ts`
- `src/server/routes/AdminInvestigateRoutes.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- adjacent tests

Changes:

- Tie inline full-refresh thresholds to the current active cap rung, not just the configured ceiling.
- Tie automatic large-rebuild tuning to the current active cap rung as it steps down, not just stored manual or machine-local ceiling values.
- Replace direct runtime decisions that read `process.env.DUCKDB_MEMORY_LIMIT` or stored background-writer memory settings with the shared active-cap accessor.
- Expose both configured ceiling and current active cap rung in worker diagnostics, plus refresh and rebuild cooldown or paused state, so routing and recovery decisions are inspectable.
- Update review-warning and related status routes so `paused` or cooled-down work is surfaced as blocked or failed rather than refreshing.
- Do not infer active refresh work from `lease_expires_at` alone; require `refresh_status = 'running'` before treating a row as in flight.
- Keep project-local routing conservative under smaller caps so the system avoids repeated reactive OOM cycles.

Expected result:

- More heavy work is diverted before it OOMs.
- Recovery converges instead of oscillating between failure and immediate retry.
- Predictive routing, tuning, and diagnostics stay aligned with the actual runtime cap.
- Operator and review-status surfaces stay aligned with the actual recovery state.

## Step 6. Add A Writer-Wide Heavy-Work Breaker

Files:

- `src/server/utils/startBackgroundWork.ts`
- `src/server/utils/projectMartRefreshWorkerHeartbeat.ts`
- `src/server/utils/projectMartLargeRebuildHeartbeat.ts`
- `src/server/cron/fullTextJobs.ts`
- `src/server/cron/fullTextConversionJobs.ts`
- `src/server/cron/judgmentsJobs.ts`
- `src/server/routes/AdminInvestigateRoutes.ts`
- adjacent tests

Changes:

- When multiple OOMs occur in a short window, suspend only heavy background work for a `5m` cooldown after `3` qualifying OOMs inside `60s`.
- Gate `projectMartRefreshWorker`, `projectMartLargeRebuildHeartbeat`, `fullTextJobs`, `fullTextConversionJobs`, `runAddToQueue`, and `importJudgmentsCron` behind the breaker.
- Keep `sendToLLM`, `checkLLMStatusCron`, and `cleanupStaleQueueCron` running because they are lease, status, or cleanup work rather than the DuckDB-heavy paths the breaker is meant to shed.
- Make operator-triggered large rebuild runs respect both project-local retry-after cooldown and the breaker. During either cooldown, return an explicit blocked response with a reason and `retryAfter` instead of silently bypassing the safety rail. Do not add an implicit operator override in this plan.
- Keep API flow alive and let lighter writer work resume once the controlled restart gate clears. Non-DuckDB API routes should stay available even when DuckDB-backed work is waiting behind a controlled restart gate.
- Let heavy loops auto-resume after cooldown without human intervention.

Expected result:

- Global pressure events no longer collapse into noisy retry storms.
- The process remains up and eventually resumes heavy work automatically.
- Operator-triggered rebuilds fail fast with a clear cooldown reason instead of bypassing the safety rail.

## Implementation Order

1. Build the shared OOM recovery governor, derive the startup cap rung before first DuckDB open, and add a controlled restart gate that serializes through the main DuckDB queue.
2. Add retry-after gating and status-aware retry ordering to mart refresh and large rebuild claim logic.
3. Add mart-refresh pause and resume state support so floor-exhausted refreshes are recoverable without manual DB edits.
4. Update refresh and rebuild diagnostics and review-status surfaces so `running`, cooldown, and `paused` are reported correctly.
5. Make `projectMartRefreshWorkerHeartbeat` restart escaped loops automatically.
6. Wire mart refresh OOM handling into the governor and cooldown path.
7. Wire large rebuild OOM handling into the governor and cooldown path.
8. Tie predictive thresholds, rebuild tuning, and diagnostics to the shared active cap rung.
9. Add the writer-wide heavy-work breaker, scope it to heavy background paths, and make operator-triggered rebuilds respect both project-local cooldown and breaker cooldown.
10. Reproduce forced OOM paths and verify that no manual restart is required.

## Done Criteria

- The first embedded DuckDB open uses the highest ladder rung at or below the configured ceiling instead of booting at the raw ceiling.
- A DuckDB OOM in mart refresh or large rebuild does not require restarting the worker process.
- The active DuckDB cap steps down automatically through the configured ladder until `1024MiB`.
- Controlled DuckDB restart drains queued work through a restart gate instead of racing an in-process close, and non-DuckDB API flow stays up during cap step-down.
- Mart refresh admission, large rebuild tuning, and worker diagnostics all read the same active runtime cap source.
- Failed heavy work is not immediately reclaimable; cooldown prevents thrash.
- Cooled-down failed work is retried automatically but does not jump ahead of fresh claimable work.
- Work that still OOMs at `1024MiB` transitions to `paused` instead of remaining in retryable `failed` state.
- Paused mart refresh and large rebuild rows both have explicit operator resume paths.
- Heavy work resumes automatically after cooldown when recovery remains possible.
- Work that still OOMs at `1024MiB` stops locally without taking down the writer or the API server.
- Review warnings and worker diagnostics do not misclassify paused or cooled-down work as active refreshing.
- The writer-wide breaker pauses only the named heavy background paths, and operator-triggered rebuilds return a clear blocked response during project-local cooldown or breaker cooldown.

## Touched Layers

- server
- database
- docs
- tests

## Quality Gates

- `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- `bun test src/server/services/projectMartRefreshStateService.test.ts`
- `bun test src/server/services/projectMartLargeRebuildStateService.test.ts`
- `bun test src/server/services/projectMartLargeRebuildCyclesService.test.ts`
- `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- `bun test src/server/utils/duckdbServiceReload.test.ts`
- `bun test src/server/utils/duckdbServiceMemoryLimit.test.ts`
- `bun test src/server/utils/backgroundServerStack.test.ts`
- `bun test src/server/utils/martRefreshDrainHeartbeat.test.ts`
- `bun test src/server/utils/startBackgroundWork.test.ts`
- `bun test src/server/routes/AdminInvestigateRoutes.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts`
- `bun run lint`
- `bun run dev:server`
- Verification from server output that:
  - first DuckDB startup uses the highest rung at or below the configured ceiling
  - worker remains up after forced or mocked OOM handling
  - controlled in-process restart drains queued DuckDB work cleanly and reopens DuckDB at the lower rung after cap step-down
  - cap rung steps down automatically
  - mart refresh routing, large rebuild tuning, and diagnostics report the same active rung
  - paused or cooled-down work is reported as blocked or failed rather than refreshing
  - only the named heavy background loops pause during breaker cooldown while lighter cron work stays alive
  - `fullTextJobs` and `fullTextConversionJobs` also respect breaker cooldown and auto-resume afterward
  - operator-triggered rebuilds return an explicit blocked response during project-local cooldown and breaker cooldown
  - heavy work resumes after cooldown when recovery is still possible
- `bun run build` not required unless the implementation expands into app or admin UI changes.
- Desktop verification not required unless the implementation expands into shared UI or desktop-specific runtime controls.

## Commands Reviewed

- `bun run dev:server`
- direct `bun run src/server/index.ts` worker starts with varying `DUCKDB_MEMORY_LIMIT`
- `bun scripts/repairProjectMartRefreshLedger.ts`
- `duckdb "data/runtime/primary/forska.duckdb" ...`
- targeted `bun test ...` and `bunx eslint ...` for the server paths already touched during investigation
- Obvious implementation commands such as the final quality gates above were not run for this file because this change is planning-only.
