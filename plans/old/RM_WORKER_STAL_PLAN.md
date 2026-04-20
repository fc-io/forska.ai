# Review Mart Worker Stall Recovery Plan

> For Hermes: Use subagent-driven-development skill to implement this plan task-by-task.

Goal: Make project mart refresh work recover automatically when a worker dies, and make the reviews warning banner report true worker state instead of showing abandoned claims as active processing.

Architecture: Keep the new ledger-based refresh system. Do not revive the legacy Bun/macOS crash-prone mart queue/drain path. Fix the stall by wiring the new project mart refresh worker into the safe writer-owned startup path, adding lease-expiry-aware warning semantics, and adding regression tests that prove we do not reintroduce the old Bun crash surfaces.

Tech Stack: Bun server, Elysia, DuckDB app DB, project mart refresh ledger, writer-role runtime, SolidJS reviews warnings UI, bun test.

---

## Problem Summary

Observed live state for project `184eb7f7-cc1a-4eb2-bdad-296ca872b0d7`:

- `app.project_mart_refresh_state` shows `refresh_status = 'running'`, `dirty_token = 1`, `last_completed_refresh_token = 0`
- `lease_expires_at` is long expired
- recorded worker PID is gone
- `app.project_mart_refresh_article_state` still contains `20731` dirty article rows
- UI shows `processing 1` project and `processing 20731` articles with `0/min`

Root cause hypothesis from inspection:

1. The new worker heartbeat exists in `src/server/utils/projectMartRefreshWorkerHeartbeat.ts`
2. The main server startup in `src/server/index.ts` still only starts `startMartRefreshDrainHeartbeat()`
3. `src/server/utils/martRefreshDrainHeartbeat.ts` is intentionally a no-op now
4. Therefore the real refresh worker is not part of normal startup
5. When a manually started worker dies after claiming a project, the lease expires but nothing reclaims it
6. The warnings route currently treats stale `running` ledger rows as active processing, so the UI overstates progress

This matches the user-visible freeze without requiring any new Bun crash to explain it.

---

## Constraints

1. Do not re-enable legacy queue draining in `getDuckdbMartRefreshService.ts` or `martRefreshDrainHeartbeat.ts`
2. Do not reintroduce any Bun/macOS path that previously crashed in queue/drain orchestration
3. Keep all refresh execution under the existing writer-role / DuckDB ownership model
4. Recovery must be lease-based and safe after process death
5. The warnings UI must distinguish:
   - active worker work
   - stale abandoned claim with expired lease
   - failed refresh
6. Tests must explicitly guard against accidentally bringing back the old queue/drain behavior

---

## Desired End State

1. The writer-owned server process starts the new project mart refresh worker heartbeat automatically
2. If the worker dies, expired claims become reclaimable and a fresh worker loop picks them up
3. Reviews warnings no longer count expired `running` rows as in-flight work
4. The banner text for expired claims is accurate: stalled/catching up, not actively processing
5. The old mart drain heartbeat remains unused and harmless
6. Test coverage proves:
   - startup wires the new worker heartbeat
   - startup does not depend on the legacy drain heartbeat
   - expired leases are not shown as active processing
   - abandoned claims are reclaimed by the worker service
   - runtime smoke tests show no Bun crash signatures in the intended startup path

---

## Implementation Strategy

Use the existing long-term ledger/worker design. Fix only the missing runtime wiring and stale-state interpretation.

High-level changes:

- Start `startProjectMartRefreshWorkerHeartbeat()` from `src/server/index.ts`
- Keep `startMartRefreshDrainHeartbeat()` inert or remove its startup relevance without reviving it
- In `projectsRoutesGetReviewsWarnings.ts`, compute worker activity using lease freshness, not `refresh_status === 'running'` alone
- Preserve conservative behavior: if a project is dirty but no live worker owns it, report backlog as queued/stale, not processing
- Add tests around startup wiring, warning math, lease-expiry handling, and Bun-safe runtime behavior

---

## Task 1: Add startup wiring for the real project mart refresh worker

Objective: Start the new worker heartbeat in the main server runtime where writer work is allowed.

Files:

- Modify: `src/server/index.ts`
- Modify: `src/server/utils/projectMartRefreshWorkerHeartbeat.ts`
- Test: `src/server/index.test.ts` or nearest startup/runtime test file if one exists

Step 1: Write a failing startup wiring test

- Assert writer-capable startup invokes `startProjectMartRefreshWorkerHeartbeat()`
- Assert non-writer startup does not run the worker heartbeat
- Assert startup does not require the legacy mart drain heartbeat to do useful work

Step 2: Wire startup

- Import `startProjectMartRefreshWorkerHeartbeat` in `src/server/index.ts`
- Start it beside the other writer-owned background loops
- Keep it under the same writer-role discipline already used elsewhere

Step 3: Make the worker heartbeat logging explicit and low-risk

- Ensure startup logs clearly say the project mart refresh worker loop started
- Keep logging rate-limited and safe

Step 4: Run targeted tests

- `bun test src/server/index*.test.ts`

Step 5: Commit

- `git commit -m "fix: start project mart refresh worker in writer startup"`

Quality Gates:

- Writer startup test passes
- Non-writer startup test passes
- No code path re-enables legacy queue drain behavior

---

## Task 2: Keep the old mart drain path inert and guarded

Objective: Make it hard to accidentally reintroduce the old Bun crash-prone queue drain path.

Files:

- Modify: `src/server/utils/martRefreshDrainHeartbeat.ts`
- Test: `src/server/utils/martRefreshDrainHeartbeat.test.ts`
- Optional Test: `src/server/index*.test.ts`

Step 1: Write a regression test for inert behavior

- Assert `startMartRefreshDrainHeartbeat()` does not call queue flush or start timers
- Assert it remains a safe no-op on Bun/macOS-oriented startup

Step 2: Add an explicit commentless but strongly named invariant if needed

- If code changes are needed, prefer naming and test structure over comments
- Keep this module intentionally inert

Step 3: Run targeted tests

- `bun test src/server/utils/martRefreshDrainHeartbeat.test.ts`

Step 4: Commit

- `git commit -m "test: lock legacy mart drain heartbeat to inert behavior"`

Quality Gates:

- Tests prove the old drain heartbeat stays inert
- No call path from startup to queue `flush()` is required for review refresh recovery

---

## Task 3: Fix warnings route semantics for expired claims

Objective: Stop showing dead workers as active processing.

Files:

- Modify: `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- Test: `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings*.test.ts`
- Optional Modify: `src/components/main/reviews/reviewsProjectWarnings.tsx`

Step 1: Write failing route tests

- Case A: dirty project, live unexpired running lease -> report in-flight project/article work
- Case B: dirty project, expired running lease, no active progress snapshot -> report queued/stale, not processing
- Case C: failed project -> report failed
- Case D: fresh project -> report ready

Step 2: Extend route-side project refresh state query

- Include `lease_expires_at` and possibly `worker_id` in `getProjectRefreshState`
- Add helper for `isLeaseStillActive(now, leaseExpiresAt)`

Step 3: Change in-flight count math

- Only set `isProjectRunning` when:
  - project is dirty and
  - either progress snapshot contains the project/article, or ledger says running with an unexpired lease
- If lease is expired and no live snapshot evidence exists, treat the work as pending/queued instead of processing

Step 4: Revisit status wording if needed

- If `refresh_status = 'running'` but lease expired, prefer `stale` or `refreshing` with queued semantics, not active processing semantics
- Preserve frontend contract shape unless a deliberate migration is needed

Step 5: Run targeted tests

- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings*.test.ts`

Step 6: Commit

- `git commit -m "fix: treat expired mart refresh claims as queued not active"`

Quality Gates:

- Expired lease test passes
- UI contract shape is preserved
- Banner no longer claims abandoned work is actively processing

---

## Task 4: Prove claim recovery after worker death

Objective: Ensure abandoned claims are reclaimed automatically when the new worker loop is running.

Files:

- Modify: `src/server/workers/projectMartRefreshWorker.test.ts`
- Modify: `src/server/services/projectMartRefreshStateService.test.ts`
- Optional Modify: `src/server/workers/projectMartRefreshWorker.ts`

Step 1: Write failing recovery tests

- Claim project with worker A
- Simulate lease expiry without completion
- Run worker cycle as worker B
- Assert worker B reclaims and completes the project
- Assert dirty articles are processed and completion token advances

Step 2: Tighten any recovery edge if test reveals one

- Only change worker/state code if the reclaim path is incomplete
- Do not broaden concurrency or revive old queue behavior

Step 3: Run targeted tests

- `bun test src/server/services/projectMartRefreshStateService.test.ts`
- `bun test src/server/workers/projectMartRefreshWorker.test.ts`

Step 4: Commit

- `git commit -m "test: cover project mart refresh claim recovery after worker death"`

Quality Gates:

- Lease-expiry reclaim test passes
- No duplicate completion or split-brain claim behavior

---

## Task 5: Add startup/runtime smoke coverage for Bun safety

Objective: Verify the intended startup path runs cleanly and does not reintroduce Bun crash signatures.

Files:

- Modify: existing runtime smoke test docs or add a small test helper if the repo already has a pattern
- Optional Create: `scripts/checkProjectMartWorkerStartup.ts` only if needed for safe smoke verification

Step 1: Define the exact smoke path

- Preferred runtime to verify:
  - `bun run dev:server`
  - or `bun run dev:server:writer` when isolating writer-owned background loops is safer

Step 2: Verify startup logs include the new worker

- Expect a line like:
  - `[projectMartRefreshWorker] background loop starting`

Step 3: Verify logs do not contain Bun native crash signatures

- Check for:
  - `panic: A C++ exception occurred`
  - `oh no: Bun has crashed`
  - repeated code 133 restart loops
  - repeated `bun.report` links

Step 4: Verify old queue/drain path is not used for this recovery path

- No startup dependence on legacy drain flush
- No queue heartbeat resurrected

Step 5: Document exact commands run

- `bun test src/server/index*.test.ts`
- `bun test src/server/utils/martRefreshDrainHeartbeat.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings*.test.ts`
- `bun test src/server/services/projectMartRefreshStateService.test.ts`
- `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- `bun run lint`
- `bun run build`
- `bun run dev:server`

Step 6: Commit

- `git commit -m "test: add bun-safe startup verification for mart refresh worker"`

Quality Gates:

- Tests pass
- Lint passes
- Build passes
- Startup smoke stays up cleanly long enough to observe worker loop startup
- No Bun native crash signatures appear in logs

---

## Task 6: Optional hardening for abandoned-running visibility

Objective: Improve observability so abandoned claims are obvious in the UI and debugging output.

Files:

- Modify: `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- Optional Modify: `src/components/main/reviews/reviewsIndexingProgress.tsx`
- Optional Modify: `src/components/main/reviews/reviewsProjectWarnings.tsx`

Step 1: Add failing tests if you expose new metadata

- Example: `hasExpiredLease`, `workerLeaseExpired`, or `isAbandoned`

Step 2: Surface explicit stalled state only if it preserves the current contract safely

- This is optional because the main fix is to stop calling dead work “processing”

Step 3: Run targeted tests and browser check if UI changes

- `bun run build`
- browser verification if frontend text changes materially

Step 4: Commit

- `git commit -m "feat: expose stalled mart refresh visibility in reviews warnings"`

Quality Gates:

- Added state is contract-safe and does not break existing consumers
- No extra complexity unless it materially helps diagnosis

---

## Test Matrix

Required targeted tests:

- `bun test src/server/index*.test.ts`
- `bun test src/server/utils/martRefreshDrainHeartbeat.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings*.test.ts`
- `bun test src/server/services/projectMartRefreshStateService.test.ts`
- `bun test src/server/workers/projectMartRefreshWorker.test.ts`

Required repo-native quality gates:

- `bun run lint`
- `bun run build`

Required runtime smoke test:

- `bun run dev:server`
- Let it run long enough to verify:
  - server startup succeeds
  - writer-owned background loops start
  - project mart refresh worker loop starts
  - no Bun native crash signatures appear

Optional safer local isolation smoke test:

- `bun run dev:server:writer`

---

## Explicit Bun Crash Prevention Checks

The implementation is not complete unless all of these are true:

1. The fix does not re-enable `app.mart_refresh_queue` drain heartbeat processing
2. `startMartRefreshDrainHeartbeat()` remains inert and tested as such
3. The new worker startup path uses only the ledger-based worker loop
4. Runtime verification shows no:
   - `panic: A C++ exception occurred`
   - `oh no: Bun has crashed`
   - code 133 restart loops
   - repeated native crash reports
5. No new direct queue-drain call is introduced into warning routes, startup, or background loops

---

## Rollout Notes

Preferred rollout:

1. Land startup wiring + inert legacy guard tests
2. Land expired-lease warning math tests and fix
3. Land worker reclaim recovery test
4. Run full quality gates and Bun-safe runtime smoke test
5. Only then verify on a real stalled project that the worker reclaims expired claims and the banner reflects true status

Do not combine this with unrelated mart refresh optimization or queue cleanup changes.

---

## Recommendation

Implement the smallest durable fix:

- start the real worker heartbeat in writer startup
- keep the old drain path inert
- make warnings lease-aware
- add explicit anti-crash regression tests around the startup/runtime path

That should unfreeze real backlog recovery without reopening the Bun/macOS crash surface you intentionally removed.
