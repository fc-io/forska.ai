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

## Root-Cause Hypothesis To Prove

The working root cause is a storage/access-path problem, not an exception
handling problem:

1. Dirty-work lane identity is still represented primarily through wide string
   keys such as `projection_key` plus source-partition predicates.
2. Completion, retention, and rebuild-covered retirement can find candidate rows
   by re-evaluating those broad lane predicates against the hot
   `app.review_serving_dirty_work` table.
3. On the current million-row class backlog, those predicates make DuckDB scan
   and decompress too much dirty-work state before it can update a small number
   of rows.
4. Because the DuckDB owner is serialized, that scan monopolizes the owner and
   delays unrelated foreground API reads.

The fix is complete only when evidence shows this access path is gone from hot
maintenance work. The replacement model must identify work by compact lane keys
and then update bounded exact row ids.

## Explicit Non-Fixes

These may be useful as diagnostics or short-term mitigations, but they do not
complete this plan:

- adding more error catching, retries, or timeout handling around dirty-work
  drain
- reducing dirty-work batch size while preserving the same broad predicate
  update/retirement path
- running the same scan-heavy path under a higher-memory owner without
  operator supervision and route-latency evidence
- hiding dirty-work backlog from the warning API without fixing drainability
- marking dirty rows complete solely because a visible surface looks ready,
  without manifest/watermark coverage evidence

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
- Diagnostics classify redundant high-water lanes before normal dirty-work
  drain is re-enabled, so implementation effort is not spent replaying obsolete
  rows one by one.
- The warning API can continue showing compact counts while diagnostics expose
  the actual component/lane split.

### 2. Make Lane Predicates Cheap In Storage

Add or validate a storage shape that makes dirty-work lane predicates cheap
before relying on exact-row completion, coalescing, or covered-row retirement.

The implementation should avoid repeatedly parsing or comparing compressed
string/JSON projection keys in hot completion paths. Persist or materialize the
fields needed to identify a lane:

- project id
- component
- projection identity or compact projection identity key
- source partition / lane
- dirty status
- dirty source watermark / high-water range
- terminal reason, when applicable

Tasks:

- Decide whether the existing lookup tables from prior dirty-work/ACK work are
  sufficient or whether a new compact lane table / numeric lane key is needed.
- Add a migration/backfill path for current rows without a startup-wide
  blocking scan.
- Keep the write path authoritative: new dirty rows must carry the same compact
  lane keys at creation time.
- Prove with query plans and current-DB timing that claim, coalesce, ACK, and
  retirement predicates use the compact lane shape instead of full-table
  compressed string scans.

Acceptance criteria:

- Hot dirty-work queries no longer depend on decompression-heavy string/JSON
  predicates for project/component/projection/source/status/watermark lanes.
- Current-DB `EXPLAIN` or equivalent query-plan evidence shows bounded scans or
  keyed joins for claim, coalescing, completion, and covered-row retirement.
- Backfill/migration can run incrementally or under an explicit maintenance
  window without monopolizing the foreground owner.

### 3. Make Completion Exact-Row Based

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

### 4. Coalesce Superseded High-Water Work

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
- Record an explicit lifecycle reason for rows retired by coalescing, such as
  `superseded_by_high_water`.

Acceptance criteria:

- Repeated project-scope invalidations collapse to one pending row per
  compatible lane/component/projection identity.
- Coalescing is idempotent.
- Historical diagnostic evidence remains queryable.

### 5. Retire Rows Covered By Full Rebuilds

When a full component rebuild has promoted a component generation at or beyond a
dirty source watermark, retire dirty-work rows that are now provably covered.

This must not reintroduce the current failure mode by joining coverage back to
`app.review_serving_dirty_work` through broad project/projection/source
predicates. The covered candidate set must be materialized as bounded exact ids
first, then terminal state must be updated by those ids.

Tasks:

- Select covered candidate ids in bounded batches using compact lane keys.
- Materialize exact `dirty_work_id` / physical row identities before terminal
  update.
- Mark covered rows with an explicit reason such as `covered_by_rebuild`.
- Preserve non-covered, failed, quarantined, and incompatible-projection rows.
- Capture `EXPLAIN` / current-DB timing evidence for both candidate selection
  and terminal update.

Acceptance criteria:

- A completed/promoted rebuild can clear stale dirty backlog without replaying
  each obsolete dirty row through the projector.
- Coverage checks use manifest/component watermarks and projection identities,
  not wall-clock assumptions.
- Covered-row retirement updates exact materialized ids only; no final update
  step may rescan the million-row dirty-work backlog by string-key predicates.
- Rows not covered by the promoted rebuild remain pending.

### 6. Define Dirty-Work Lifecycle Reasons

Make row lifecycle semantics explicit so diagnostics can distinguish useful
work from cleanup decisions.

Suggested terminal or audit reasons:

- `projected`: the row was claimed, projected, and acknowledged normally
- `superseded_by_high_water`: a newer high-water row covers the same compatible
  lane
- `covered_by_rebuild`: a promoted full rebuild covered the row's dirty source
  watermark
- `failed`: projection failed and needs retry/operator attention
- `quarantined`: work is blocked by preserved quarantine evidence
- `moved_to_audit`: detailed evidence was retained outside the hot dirty-work
  table

Acceptance criteria:

- Diagnostic queries can count and sample each lifecycle reason.
- Operators can distinguish replayed rows, coalesced rows, rebuild-covered rows,
  failed rows, and quarantined rows.
- Retention cleanup never erases the only evidence explaining why a row stopped
  being pending.

### 7. Re-enable Low-Memory Dirty-Work Drain

After exact-row completion and coalescing are in place, re-enable dirty-work
drain under the low-memory owner with a conservative bounded budget.

Suggested initial policy:

- keep rebuild chunks prioritized
- allow a small dirty-work row budget only after rebuild chunks yield owner time
- enforce foreground DuckDB queue checks between batches
- keep RSS/recycle guards from PR #372

Acceptance criteria:

- The primary stack drains dirty work without warning/API route timeouts.
- Foreground warning, review-list, detail, and search routes remain responsive
  during drain. Define the concrete threshold in the PR using the current route
  timeout budget; at minimum, report timeout count, sampled p95/p99 latency, and
  maximum DuckDB foreground queue wait while drain is active.
- DuckDB foreground queue depth returns near zero between dirty-work batches.
- Backlog count decreases across live samples.

## Operational Mitigation

A separate higher-memory maintenance profile can be useful for controlled
backlog drain, but it should be treated as a mitigation, not the durable fix.

Use it only when:

- exact-row completion/coalescing has landed, or the drain is explicitly
  operator-supervised and bounded
- foreground API reads are isolated from the heavy owner
- before/after backlog, route latency, owner RSS, and DuckDB queue metrics are
  recorded

Do not rely on a higher-memory profile to justify keeping a table-scan
completion path.

Unsupervised higher-memory drain requires the same exact-row/coalescing
acceptance evidence as the low-memory drain.

## Verification

Focused tests:

- dirty-work claim/coalescing/completion tests
- dirty-work lifecycle reason and diagnostic sampling tests
- projector worker low-memory budget tests
- review warning route/component tests for ready visible surfaces plus
  background maintenance backlog
- SQL-shape tests that guard against full dirty-work table scans in completion
  updates and rebuild-covered retirement updates

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
- sampled route latency or timeout evidence for warning, review list, detail,
  and search endpoints
- DuckDB foreground queue wait/depth while dirty-work drain is active
- no new failed/quarantined chunks or dirty-work rows

## Rollout

1. Land diagnostics first if the implementation cannot be finished in one
   coherent PR.
2. Land or validate the compact lane storage shape before changing drain
   budgets.
3. Use diagnostics to classify redundant lanes, then run coalescing and
   rebuild-covered retirement before normal dirty-work drain.
4. Land exact-row completion with lifecycle reasons in the same coherent slice
   as coalescing/retirement if they touch the same ACK semantics.
5. Re-enable low-memory dirty-work drain only after live current-DB evidence
   shows completion no longer pins the owner.
6. Keep the warning copy from PR #372: visible review/search readiness and
   background maintenance backlog remain separate concepts.
