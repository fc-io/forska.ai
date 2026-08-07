# Project Transfer Exclusive DuckDB Plan

## Goal

Make large project-transfer import analyze/commit work complete on low-memory machines by suspending competing DuckDB work instead of relying on concurrent memory headroom. A machine with about `6400MiB` available to the app should not fail tiny metadata writes or rollback because review-serving or startup maintenance filled the shared DuckDB runtime first.

This plan targets the current shared split-runtime owner model. It does not make the import algorithm itself streaming; it creates an exclusive DuckDB window for the existing heavy import phases, keeps progress visible, and prevents background/native-heavy work from competing for the same allocator.

## Current Problem

- The normal low-memory owner profile is around `6400MiB`.
- Large project-transfer imports have genuinely heavy phases:
  - `projectTransfer.import.analyze.operationTables`
  - `projectTransfer.import.commit.transaction`
- Review-serving maintenance, bounded rebuild chunks, retention, startup preflight, and project-transfer import can all use the same embedded DuckDB owner runtime.
- When review-serving or startup work leaves DuckDB near the cap, unrelated tiny foreground writes can fail, for example `INSERT INTO app.project_transfer_session`.
- Temporarily raising memory for the import lanes helps high-memory machines, but it does not make low-memory machines reliable. It also hides whether other shared DuckDB work is competing during the import.

## Design

Introduce a first-class **DuckDB exclusive work lease** for memory-heavy foreground transfer phases.

The lease should mean:

- One heavy foreground operation owns DuckDB admission at a time.
- Heavy work does not start immediately after taking the lease. It first waits until existing DuckDB work drains and the owner memory is ready.
- Review-serving projector work, retention cleanup, dirty-work draining, rebuild chunk claiming, and other background DuckDB maintenance yield while the lease is active.
- New non-essential foreground rebuild drains do not start while the lease is active.
- Lightweight project-transfer session/progress reads and progress writes remain allowed so the UI can show progress.
- Runtime readiness remains `ready`; the app is not down. Only competing maintenance is suspended.
- On release, the owner recycles or garbage-collects the DuckDB runtime before background work resumes if RSS or DuckDB memory was raised/reached the cap.

## Implementation Steps

### 1. Add a shared exclusive DuckDB activity registry

Create a small module under `src/server/utils/` or `src/server/services/projectTransfer/`, for example:

- `src/server/utils/duckdbExclusiveWork.ts`

It should expose:

- `runWithDuckdbExclusiveWork({kind, sessionId, phase, ownerToken, estimatedRows}, operation)`
- `prepareDuckdbExclusiveWork({kind, sessionId, phase, ownerToken, estimatedRows})`
- `hasActiveDuckdbExclusiveWork()`
- `getActiveDuckdbExclusiveWorkSnapshot()`
- optional test reset helper

Keep this process-local first. The current problem is within the maintenance owner process. Persisted state can come later if needed for multi-process visibility.

The snapshot should include enough UI/operator detail:

- `kind: 'project_transfer_import'`
- `phase: 'analyze' | 'commit'`
- `sessionId`
- `startedAt`
- `lastProgressedAt`
- `message`
- `admissionState: 'requested' | 'draining' | 'recycling' | 'ready' | 'running' | 'releasing'`
- `blockedBy: {foregroundQueueDepth, appendQueueDepth, backgroundQueueDepth, activeMaintenance?: string[]}`
- optional `completedRows`, `totalRows`, `percent`

Do not overload `projectTransferBackgroundActivity`; that currently only says "something transfer-ish is active" and was already too coarse for recycle decisions.

### 2. Add an admission preflight before heavy work starts

Exclusive import analyze/commit must wait for DuckDB to be ready before starting the memory-heavy operation.

Admission sequence:

1. Mark exclusive work as `requested`.
2. Stop admitting new competing DuckDB work.
3. Mark `draining` and wait for existing DuckDB queues to drain:
   - main/foreground queue depth
   - append queue depth
   - background queue depth
4. Wait for active review-serving/maintenance chunks to finish or reach a safe yield boundary. Do not kill in-flight DuckDB transactions.
5. If RSS remains near the low-memory cap after draining, mark `recycling`, close/reopen DuckDB without checkpoint, and force GC.
6. Re-check queue depths and RSS.
7. Mark `ready`, then run the heavy phase and mark `running`.

The wait must be bounded and visible:

- Update project-transfer session progress while waiting, for example `message: 'Waiting for DuckDB maintenance work to pause'`.
- Include `blockedBy` diagnostics in runtime state.
- If the wait exceeds a configured timeout, fail before the heavy phase starts with a clear retryable error rather than beginning under memory pressure.
- Use a conservative default timeout, then tune from live current-DB evidence.

This step is not optional. Without it, exclusive mode can still start after another process has already filled the allocator, reproducing the `6.2 GiB/6.2 GiB used` failure.

### 3. Wrap only the truly heavy project-transfer phases

Use the lease around:

- `analyzeProjectTransferImportPackage` target-state operation-table analysis in `src/server/services/projectTransfer/projectTransferAnalyze.ts`
- `runClaimedProjectTransferImportCommit` / `repositories.runAppTableWrites` in `src/server/services/projectTransfer/projectTransferCommit.ts`

Do not wrap:

- session creation
- session/status polling
- upload
- dependency resolution metadata updates
- project-transfer recovery
- terminal cleanup

Progress writes in `project_transfer_session.progress_json` must continue during the lease. The lease snapshot should be refreshed from the same progress callback path that already updates import progress.

### 4. Teach review-serving and maintenance to yield to exclusive work

Add an admission guard before review-serving claims or starts native-heavy work:

- `src/server/workers/reviewServingProjectorWorker.ts`
- `src/server/utils/reviewServingProjectorWorkerHeartbeat.ts`

Behavior:

- If exclusive work is active, do not claim rebuild chunks.
- Return a blocked/idle result with a distinct reason like `duckdb_exclusive_work_active`.
- Do not treat this as stalled or failed.
- Keep wakeups cheap and periodic so review-serving resumes after release.
- Avoid the old "skip recycle because project transfer active" behavior becoming a stale global block. The exclusive lease should be scoped and released in `finally`.

Also check other maintenance wakes that can touch large DuckDB state:

- `src/server/utils/startBackgroundWork.ts`
- `src/server/utils/reviewBulkOperationWorkerHeartbeat.ts`
- `src/server/utils/comparisonProjectServingMaintenanceWorkerHeartbeat.ts`
- `src/server/utils/startRequestAttemptCloseoutBackfillScheduler.ts`
- retention cleanup
- dirty refresh/service drains
- startup proactive mutation preflight
- background cron import/recovery jobs

The default should be: if the work is not required for the active transfer phase or progress visibility, it yields.

Existing code already has one coarse project-transfer guard in the review-serving projector path:

- `hasActiveProjectTransferForReviewServingProjectorWorker` in `src/server/workers/reviewServingProjectorWorker.ts`
- heartbeat recycle skip logic in `src/server/utils/reviewServingProjectorWorkerHeartbeat.ts`

Do not rely on that coarse guard as the final design. The plan needs a narrower exclusive-work guard because the old project-transfer activity state can stay too broad for recycle decisions, and it does not cover all maintenance loops started from `startBackgroundWork`.

### 5. Add an owner-local admission barrier in DuckDB service

The high-level worker guards are necessary but not sufficient. Add a last-resort admission check in `src/server/utils/duckdbService.ts` using `DuckdbWorkloadContext`:

- Allow while exclusive work is active:
  - the exclusive owner operation itself
  - `projectTransfer.session` progress/session writes and reads
  - route/status reads needed by the active import UI
  - runtime readiness and owner diagnostics
- Reject or queue non-essential background classes:
  - `reviewProjector`
  - maintenance retention/cleanup
  - startup proactive preflight
  - background queue drains

Prefer yielding/retrying for background jobs over returning user-visible 500s. For foreground routes that cannot proceed, return a clear 409/503-style API error: "DuckDB is reserved for import commit/analyze; retry after current import phase completes."

The barrier should also provide queue/readiness metrics to the exclusive-work preflight so it can wait for existing work to finish before the heavy phase starts.

### 6. Surface exclusive mode in API and UI

Add diagnostics to an ownerless-readable route, probably extending one of:

- `/api/runtime/ready`
- `/api/runtime/state`
- `/api/duckdb_owner_connections`

The API should report:

- `duckdbExclusiveWork.active`
- `kind`
- `phase`
- `sessionId`
- `admissionState`
- `blockedBy`
- `startedAt`
- `lastProgressedAt`
- optional progress fields

UI expectations:

- The import session screen/action already polls session progress; use that as the primary progress bar.
- Review-serving warnings should show a non-alarming blocked state when indexing is paused because import exclusive work is active.
- Browser and desktop flows should both show the same import progress/status because they use the shared API.

Do not make the whole app look down. Say the import is running and indexing/maintenance is paused.

Concrete UI/API integration points to inspect:

- `src/server/routes/runtimeReadyRoutes.ts` for runtime state/readiness diagnostics.
- `src/server/routes/DuckdbOwnerConnectionsRoutes.ts` for owner connection diagnostics.
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts` for review indexing `blockedReason`, `progressState`, `recoveryMode`, and `recoveryContext`.
- `src/components/main/reviews/reviewsProjectWarnings.tsx` and related tests for user-facing blocked indexing copy.
- project-transfer import action/session polling components under `src/components/main/projectsGrid/`.

### 7. Release and cleanup rules

The exclusive lease must release in `finally`.

After a heavy phase:

- restore any temporary DuckDB memory limit if it was raised
- recycle DuckDB without checkpoint if RSS is at or above the low-memory cap
- run `Bun.gc(true)`
- log release with duration, peak RSS, and phase result

If the process crashes, startup recovery should see any stuck import session through existing project-transfer recovery and mark/requeue/fail it as today. The process-local exclusive lease does not need persistence for crash cleanup.

### 8. Remove broad memory headroom once exclusive mode is proven

Keep the current temporary headroom only as a compatibility bridge while implementing.

After live proof:

- narrow headroom to only the exclusive operation body
- remove any accidental session/recovery headroom
- keep log attrs with `routeOrJobKey`, `sessionId`, and `phase`

The end state should be: low-memory machines run imports by suspending competitors; high-memory machines may still use configured headroom, but not to paper over competition.

## Tests

Add focused tests before the current-DB gate:

- `src/server/services/projectTransfer/projectTransferDuckdbAccess.test.ts`
  - heavy analyze/commit paths carry the exclusive/heavy workload context
  - session/recovery paths do not accidentally become heavy/exclusive
- `src/server/services/projectTransfer/projectTransferBackgroundActivity.test.ts` or new `duckdbExclusiveWork.test.ts`
  - lease increments/decrements
  - `finally` release after throw
  - snapshot progress updates
  - admission state moves `requested -> draining -> recycling/ready -> running -> releasing`
  - heavy operation does not start until queue depths are drained and memory is below the ready threshold
  - timeout fails before heavy work starts
- `src/server/workers/reviewServingProjectorWorker.test.ts`
  - worker does not claim chunks while exclusive import work is active
  - worker resumes after release
  - blocked/yield result is not terminal failure
- `src/server/utils/reviewServingProjectorWorkerHeartbeat.test.ts`
  - bounded restart/recycle logic does not skip forever on stale transfer activity
  - active exclusive work prevents unsafe recycle/start of next bounded chunk
- `src/server/utils/duckdbServiceWorkloadContext.test.ts`
  - background `reviewProjector`/maintenance work is blocked or yielded during exclusive import
  - project-transfer session/progress work remains allowed
- `src/server/routes/runtimeReadyRoutes.test.ts` or owner diagnostics route test
  - exclusive work is visible in runtime state while readiness remains true
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
  - review indexing reports a paused/blocked-by-import state without failed/stalled copy
- `src/server/utils/startBackgroundWork.test.ts`
  - non-review-serving maintenance loops yield while exclusive import work is active
- Project-transfer route/service tests
  - analyze and commit enter exclusive mode only for heavy phases
  - analyze and commit publish "waiting for DuckDB maintenance work to pause" progress before heavy work when queues are active
  - progress updates continue during exclusive mode

## Quality Gates

Run these in order:

```bash
bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts src/server/services/projectTransfer/projectTransferCommit.test.ts src/server/services/projectTransfer/projectTransferSessionRepository.test.ts
bun test src/server/services/projectTransfer/projectTransferDuckdbAccess.test.ts src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts
bun test src/server/workers/reviewServingProjectorWorker.test.ts src/server/utils/reviewServingProjectorWorkerHeartbeat.test.ts
bun test src/server/utils/startBackgroundWork.test.ts src/server/utils/duckdbServiceWorkloadContext.test.ts src/server/utils/duckdbServiceReload.test.ts src/server/routes/runtimeReadyRoutes.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts
bun run lint
git diff --check
bun run test:bun
bun run test:vitest
bun run test:playwright
```

Because this touches DuckDB lifecycle and review-serving maintenance, the final proof must include the current-DB live gate:

```bash
bun run test:network-smoke:current-db
```

Before merge, also run a manual live import on the primary DB and capture:

- API/owner/judge readiness before import
- owner RSS before import
- exclusive mode active during analyze/commit
- no review-serving chunk claims during exclusive mode
- import progress moves while maintenance is paused
- import completes or reaches the expected validation state
- owner RSS after release/recycle
- review-serving resumes and progresses afterward
- no DuckDB OOM, rollback, checkpoint/WAL, owner heartbeat, or 500 logs

## OOM Documentation

When implementing, add a short `OOM_ERRORS.md` entry:

- Error: fatal rollback OOM / import heavy phase memory competition
- Context: project-transfer import analyze/commit under low-memory split owner
- Cause: competing DuckDB maintenance and import data-plane work shared one constrained embedded runtime
- Fix: exclusive DuckDB import lease suspends competing background/native-heavy work while preserving progress/status
- Verification: focused tests plus current-DB live import evidence

## Risks

- A too-broad barrier could block useful readonly product routes. Keep allow/deny based on `DuckdbWorkloadContext`, not raw SQL text.
- A stale lease would pause maintenance. Use `finally`, duration logging, and diagnostics visibility.
- Progress writes could deadlock if they are routed through the same blocked class. Explicitly allow project-transfer session/progress work.
- Review-serving freshness may lag during imports. The UI should say maintenance/indexing is paused by import work, not failed.
- This does not reduce the import working set. It makes low-memory behavior deterministic by removing competitors. A later streaming/chunked import redesign is still the durable way to reduce peak memory.
