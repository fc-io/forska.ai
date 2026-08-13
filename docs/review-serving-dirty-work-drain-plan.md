# Review-Serving Dirty-Work Drain Plan

Date: 2026-08-13

## Goal

Make review-serving dirty-work catch-up safe to run under the primary low-memory
DuckDB owner without pinning foreground API reads or hiding real freshness
backlog behind disabled maintenance.

The immediate production symptom after PR #372 was not blocked search indexing:
review pages, details, and search could all be ready while the warning still
reported a large background backlog. The remaining backlog was mainly
incremental dirty-work catch-up, and a test drain of only 128 dirty rows could
pin `UPDATE app.review_serving_dirty_work` for 40s+. That means the dirty-work
completion/storage path is still too expensive on the current million-row class
backlog.

## Current Findings

- The low-memory review-serving owner can safely drain rebuild chunks after the
  search rebuild fixes.
- Dirty-work intake is currently disabled for the low-memory review-serving
  worker with `maxRowsPerWake = 0` to avoid recreating owner stalls.
- The problematic path is not claimability or retry logic. It is completion and
  ACK/storage work that can rescan compressed string-key dirty-work state when
  acknowledging a small batch.
- Much of the backlog is project-scope high-water invalidation fanned out across
  components such as `llmStatus`, `humanStatus`, `queue`, `posting`, `summary`,
  `payload`, `projectScope`, `selectedImport`, and `search`.
- Completed full rebuilds can make many older dirty-work rows redundant, but the
  system still needs explicit evidence-preserving ACK/coalescing semantics
  before retiring them.

## Principles

- Do not solve this by catching more timeouts or hiding errors.
- Do not merely reduce batch size; tiny batches already reproduce long owner
  stalls.
- Dirty-work rows must be cheap to claim, cheap to complete, and cheap to
  retire by exact physical/numeric identity.
- Coalesce superseded high-water work before it fans out into large pending
  tables.
- Preserve diagnostic evidence for failed, quarantined, or non-covered work.
- Keep foreground API reads responsive while background maintenance catches up.
- Prove the fix on the live current-DB workload, not only synthetic tests.

## Proposed Shape

### 1. Add Dirty-Work Backlog Diagnostics

Add a focused diagnostic command or extend the existing review-serving project
state inspector to split dirty work by:

- project id
- component
- source partition / lane
- projection identity
- pending/running/failed/completed status
- oldest queued timestamp
- min/max dirty source watermark
- point rows vs high-water rows
- rows covered by current active/candidate rebuild component watermarks

Acceptance criteria:

- Operators can tell whether a large backlog is active useful work, superseded
  by a rebuild, blocked by lower watermarks, or failed/quarantined.
- The warning API can continue showing compact counts while diagnostics expose
  the actual component/lane split.

### 2. Make Completion Exact-Row Based

Refactor dirty-work completion and ACK updates so the worker:

- claims a bounded batch and carries stable `dirty_work_id` / physical row
  identities through projection
- selects covered rows once
- updates terminal state by exact selected ids only
- advances source/component watermarks in the same transaction
- avoids recomputing component/project/source string-key predicates inside the
  final `UPDATE app.review_serving_dirty_work`

Acceptance criteria:

- Completing a small batch does not scan the full dirty-work table.
- A regression test fails if completion SQL recomputes coverage predicates in
  the update after exact ids were already selected.
- Source watermark and component ACK semantics remain atomic.

### 3. Coalesce Superseded High-Water Work

Add a coalescing pass for pending dirty work where only the latest high-water
row matters for a given lane/project/component/projection identity.

Rules:

- For high-water invalidations, keep the newest required watermark and retire or
  mark covered older pending rows in the same lane.
- For point acknowledgements, keep exact point semantics unless a proven
  high-water ACK covers them.
- Never delete failed/quarantined evidence silently.
- Do not coalesce across incompatible projection identities or source
  partitions.

Acceptance criteria:

- Repeated project-scope invalidations collapse to one pending row per
  compatible lane/component/projection identity.
- Coalescing is idempotent.
- Historical diagnostic evidence remains queryable.

### 4. Retire Rows Covered By Full Rebuilds

When a full component rebuild has promoted a component generation at or beyond a
dirty source watermark, retire dirty-work rows that are now provably covered.

Acceptance criteria:

- A completed/promoted rebuild can clear stale dirty backlog without replaying
  each obsolete dirty row through the projector.
- Coverage checks use manifest/component watermarks and projection identities,
  not wall-clock assumptions.
- Rows not covered by the promoted rebuild remain pending.

### 5. Re-enable Low-Memory Dirty-Work Drain

After exact-row completion and coalescing are in place, re-enable dirty-work
drain under the low-memory owner with a conservative bounded budget.

Suggested initial policy:

- keep rebuild chunks prioritized
- allow a small dirty-work row budget only after rebuild chunks yield owner time
- enforce foreground DuckDB queue checks between batches
- keep RSS/recycle guards from PR #372

Acceptance criteria:

- The primary stack drains dirty work without warning/API route timeouts.
- Foreground review routes remain responsive during drain.
- Backlog count decreases across live samples.

## Operational Mitigation

A separate higher-memory maintenance profile can be useful for controlled
backlog drain, but it should be treated as a mitigation, not the durable fix.

Use it only when:

- exact-row completion/coalescing has landed or the drain is explicitly
  operator-supervised
- foreground API reads are isolated from the heavy owner
- before/after backlog and owner responsiveness are recorded

Do not rely on a higher-memory profile to justify keeping a table-scan
completion path.

## Verification

Focused tests:

- dirty-work claim/coalescing/completion tests
- projector worker low-memory budget tests
- review warning route/component tests for ready visible surfaces plus
  background maintenance backlog
- SQL-shape tests that guard against full dirty-work table scans in completion
  updates

Quality gates:

```bash
bun test src/server/reviewServing/reviewServingDirtyWorkService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts src/server/utils/reviewServingProjectorWorkerHeartbeat.test.ts --timeout 30000
bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts --timeout 30000
bunx vitest run src/components/main/reviews/reviewsProjectWarnings.vitest.tsx
bunx eslint <changed files>
git diff --check
```

Live gates:

```bash
bun run test:review-serving:current-db-warning-status
```

For review-serving maintenance changes, also capture live progress before and
after a short interval:

- API, maintenance owner, and judge worker readiness
- dirty-work pending/running/completed counts by component
- rebuild pending/running/completed counts
- route latency or timeout evidence for the warning endpoint
- no new failed/quarantined chunks or dirty-work rows

## Rollout

1. Land diagnostics first if the implementation cannot be finished in one
   coherent PR.
2. Land exact-row completion and coalescing together if they touch the same ACK
   semantics.
3. Re-enable low-memory dirty-work drain only after live current-DB evidence
   shows completion no longer pins the owner.
4. Keep the warning copy from PR #372: visible review/search readiness and
   background maintenance backlog remain separate concepts.
