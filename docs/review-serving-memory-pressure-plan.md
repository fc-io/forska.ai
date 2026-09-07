# Review-Serving Memory Pressure Plan

Date: 2026-09-07

## Goal

Stop review-serving projector work from repeatedly driving the maintenance
DuckDB owner over the RSS cap while keeping product reads and UI diagnostics
fast during large current-DB catch-up.

The previous stabilization chain fixed foreground responsiveness and bounded
the failure mode:

- PR #422 made search rebuilds yield between ranges.
- PR #423 routed title-search dirty work through bounded rebuilds instead of
  in-place search-array updates.
- PR #424 paused projector recovery before a high-RSS maintenance-owner exit.
- PR #425 made pause recovery wait for RSS below the same effective cap.

The remaining symptom is not a stuck owner. The live +30 watch on 2026-09-07
showed API, maintenance owner, and judge staying ready; comparison
list/detail probes stayed around 5-14 ms; review-serving progressed from
`145516` to `145122` pending refreshes. But the owner repeatedly hit the RSS
cap, restarted cleanly, paused the projector by policy, and resumed. This plan
targets that remaining memory churn.

## Success Criteria

- The primary low-memory profile can drain current-DB review-serving backlog
  without repeated RSS-cap restart/pause cycles.
- Foreground product routes remain responsive while projector work runs:
  comparison project list/detail/count/stats/export-prep routes and review
  warning diagnostics should not sit behind long background writer occupancy.
- Review-serving progress keeps moving during the watch window: fresh
  `lastProgressedAt` or rebuild chunk updates, falling pending/queued counts,
  and no owner-readiness timeout pattern.
- UI surfaces continue to show readable stale/current data during background
  indexing and expose recovery state without implying hard failure.
- The final implementation is proven by targeted tests, topology CI on all
  supported OSes, and a current-DB live progress watch.

## Non-Goals

- Do not hide memory pressure by raising the desktop DuckDB memory cap.
- Do not solve this only by longer sleeps, broader retries, or quieter logs.
- Do not make default review pages depend on payload/detail enrichment.
- Do not remove bounded restart recovery until memory pressure is genuinely
  fixed; keep it as a safety net.
- Do not migrate to permanent old/new parallel serving paths. Each slice must
  have clear ownership and cleanup criteria.

## Current Findings

The remaining likely RSS sources are `summary` and `posting`.

`summary` is high risk because it builds a broad `summary_union`, expands across
list modes, prompts, judgment detail, prompt-answer facets, queue prompt arrays,
and conflict counts, then materializes source rows in JavaScript before reducing
them to accumulator records. Even 512-row chunks can fan out heavily.

`posting` is high risk because range batches build
`review_filter_posting_source_v4` as temporary state, aggregate lists, filter
lists, and merge array-valued postings against
`mart.review_article_filter_posting_serving_v4`.

`search` is better bounded after PR #423, but still deserves telemetry:
SQL-native rebuilds tokenize titles and build `LIST(DISTINCT article_id ORDER BY
article_id)`. Large common-token lists can still stress memory and validation.

`llmStatus` and `humanStatus` dirty patch paths can still materialize rows,
expand across list modes, and build large `VALUES` CTEs. Rebuild paths are more
set-based and should remain preferred for large dirty work.

`payload` is SQL-native but detail-heavy. It should remain background
enrichment: default list routes and dispatch must stay independent of payload,
while detail/export/PDF stay strict about payload readiness.

## Routes That Must Stay Fast

- `POST /api/projectsreviewswarnings`
- `GET /api/comparison-projects`
- `GET /api/comparison-projects/:id`
- `GET /api/comparison-projects/:id/stats`
- `POST /api/comparison-projects/:id/judgments`
- `POST /api/comparison-projects/:id/judgments/count`
- comparison export/import analysis routes that read serving state
- `GET /api/runtime/ready`
- lightweight owner/runtime diagnostics used during incident response

`projectsreviewswarnings` should stay bounded and stale-tolerant. It already
uses metadata-only serving reads and `serveStale` style semantics; preserve that
shape.

Comparison project serving-read routes are product reads. If they still route
through owner-dependent proxying, keep foreground priority and route latency
gates until an ownerless serving-read path exists.

## Implementation Plan

### 1. Add Per-Chunk Memory Evidence

Before changing query shapes, make the current pressure attributable.

Tasks:

- Add RSS-before/RSS-after/RSS-delta fields around projector phases:
  source query, transform/reduction, writer transaction, validation, snapshot
  promotion, DuckDB recycle, and request finalization.
- Attach the metrics to existing chunk diagnostics and rate-limited logs rather
  than adding a separate opaque log stream.
- Include DuckDB workload metrics already available today: queue wait,
  duration, result rows/bytes, temp-spill delta, memory limit, route/job key,
  and statement target.
- Add component-specific counters:
  - `summary`: source rows, contribution rows, accumulator rows, prompt-answer
    facet cardinality, reduction rows per list mode.
  - `posting`: source rows, distinct posting keys, max/avg article list length,
    temp source rows, merged rows.
  - `search`: distinct token count, max/avg token article list length,
    validation expansion rows.
  - `llmStatus`/`humanStatus`: claimed rows, materialized rows, list-mode
    expanded rows, generated SQL bytes.

Acceptance criteria:

- A single current-DB watch can identify which component and phase crosses the
  RSS cap.
- Logs distinguish DuckDB native RSS retention from JavaScript heap or
  source-row materialization.
- No new diagnostic route or log query requires slow foreground DuckDB work.

### 2. Make Projector Scheduling Adaptive Before The Cap

The current safety net reacts after RSS crosses the cap. Add earlier pressure
response so the worker slows or narrows risky work before a forced restart.

Tasks:

- Add a soft RSS threshold below the hard restart cap.
- When RSS is above the soft threshold or rising quickly, prefer lower-risk
  components and shrink `summary`/`posting` chunk budgets.
- Bound native-heavy components by both estimated article count and observed
  fanout from recent chunks.
- Yield between summary publication substeps and posting merge batches when
  foreground/background/append queues are non-empty.
- Preserve existing foreground queue checks and foreground priority.
- Keep `checkpointBeforeClose: false` for recovery recycles unless evidence
  shows checkpointing is safe under the cap.

Acceptance criteria:

- Under pressure, the worker makes smaller useful progress instead of entering
  repeated restart/pause cycles.
- A queued foreground read gets a scheduling point between risky background
  phases.
- Tests prove adaptive sizing does not starve a component indefinitely.

### 3. Convert Summary To Bounded SQL-Native Accumulation

This is the highest-value memory slice.

Tasks:

- Stop carrying large `sourceRows -> contributionRows -> summaryRecords` arrays
  in JavaScript for ordinary rebuild chunks.
- Move summary contribution expansion into bounded SQL-native staging or direct
  accumulator inserts.
- Partition summary work by article range plus list mode or contribution kind
  when fanout is high.
- Split final summary publication into smaller count/facet/reduction steps with
  explicit yields between them.
- Materialize only compact identities and aggregate rows needed for the final
  write, not raw prompt/detail fanout.

Acceptance criteria:

- Summary chunk RSS delta is bounded on current DB and does not require a
  maintenance-owner restart under the primary low-memory profile.
- Route parity and summary count/facet contracts remain exact.
- Foreground comparison and review warning probes stay responsive during
  summary rebuild and publication.

### 4. Reduce Posting Native Memory

Posting is the second likely pressure source.

Tasks:

- Measure posting fanout before writing: distinct posting keys, article-list
  length distribution, and temp source row count.
- Split posting range batches by fanout, not only article count.
- Avoid wide array merge operations where a delete/insert or partition-scoped
  replacement can update an exact bounded key range.
- Consider changing hot posting shape away from large array-valued rows if
  evidence shows common filters create pathological lists.
- Keep exact filter membership and count behavior; no approximate filters.

Acceptance criteria:

- Posting rebuilds no longer cause repeated RSS-cap recovery cycles on the
  current DB workload.
- Filtered review routes and tab counts remain exact.
- Search/list/filter foreground latency remains bounded while posting drains.

### 5. Keep Search And Status On Bounded Paths

Recent PRs fixed the worst title-search write shape. Keep that direction and
remove remaining large dirty-patch variants where current-DB evidence warrants
it.

Tasks:

- Keep title-search dirty work on bounded rebuild chunks.
- Add telemetry for common-token list size and validation expansion.
- Prefer bounded rebuild/admission over large dirty patch updates for
  `llmStatus` and `humanStatus` when dirty fanout is high.
- Cap generated `VALUES` SQL size for dirty status patches and fall back to
  rebuild chunks when exceeded.

Acceptance criteria:

- No single dirty patch can monopolize the owner main lane for tens of seconds.
- Status/search chunks split before writer execution when fanout is too large.
- Tests cover fallback from oversized dirty patch to rebuild work.

### 6. Preserve Payload As Background Enrichment

Payload work should not block the default review page.

Tasks:

- Preserve read contracts where default LLM/Human/Both/Unassessed list routes
  do not require payload.
- Keep detail/export/PDF routes strict: if payload is not ready, return typed
  availability rather than incomplete data.
- Report payload progress as enrichment, not as default-readability failure.

Acceptance criteria:

- Default rows and counts render while payload is pending.
- Detail/export/PDF cannot silently return incomplete judgment payloads.
- LLM dispatch and prompt preview remain independent of payload.

### 7. Add Ownerless Or Owner-Light Status Surfaces

The UI and incident diagnostics should not need slow owner work to explain that
the owner is busy or recovering.

Tasks:

- Add or extend an ownerless/read-only status surface for review-serving:
  pause marker state, owner readiness, queue depths, last progress, readable
  snapshot coverage, and recent recovery reason.
- Consider ownerless serving-status/progress for comparison projects while
  keeping mutations owner-routed.
- Keep product data reads exact; use ownerless paths for status/diagnostics
  only unless a read-only snapshot lane is explicitly implemented.

Acceptance criteria:

- During projector recovery pause, the UI can explain the state without waiting
  on the DuckDB owner.
- `paused_by_policy` remains a recovery state, not a generic failure.
- Runtime diagnostics remain available during owner pressure.

## Verification Plan

Focused tests:

```bash
bun test src/server/workers/reviewServingProjectorWorker.test.ts \
  src/server/utils/reviewServingProjectorWorkerHeartbeat.test.ts \
  src/server/utils/startBackgroundWork.test.ts
```

Component and query-shape tests:

```bash
bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts \
  src/server/reviewServing/reviewServingFilterPostingProjector.test.ts \
  src/server/reviewServing/reviewServingTitleSearchProjector.test.ts \
  src/server/reviewServing/reviewServingLlmStatusProjector.test.ts \
  src/server/reviewServing/reviewServingHumanStatusProjector.test.ts \
  src/server/reviewServing/reviewServingProjectorWriter.test.ts
```

Readiness, routing, and UI tests:

```bash
bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts \
  src/server/routes/ComparisonProjectsRoutes.servingContract.test.ts \
  src/server/routes/apiRouteClassification.test.ts \
  src/server/routes/ApiProxyRoutes.retry.test.ts \
  src/server/routes/runtimeReadyRoutes.test.ts \
  src/server/services/readOnlyDuckdbServiceWorkloadContext.test.ts

bunx vitest run src/components/main/reviews/reviewsProjectWarnings.vitest.tsx \
  src/components/main/reviews/getReviewIndexingInProgressTitle.test.ts \
  'src/app/routes/+compare-judgments/+$id/+index/comparisonProjectServingProgress.test.ts'
```

Workflow gates:

```bash
bun run test:judgment-workflow
bun run test:judgment-workflow:e2e
bun run test:judgment-workflow:recovery
bun run test:judgment-workflow:topology
bun run test:judgment-workflow:browser
```

Current-DB gate:

```bash
bun run test:network-smoke:current-db
```

Live evidence before PR merge:

- Check API, maintenance owner, and judge readiness.
- Record review-serving progress counters before and after at least a 30-minute
  watch on the current DB.
- Record per-component RSS deltas and whether any recovery pause marker is
  created.
- Probe comparison list/detail and `projectsreviewswarnings` during active
  projector work.
- Confirm no owner-readiness timeout pattern, no 20s foreground route stall, no
  crash loop, and no stalled `lastProgressedAt`.

CI evidence:

- `judgment-workflow-topology.yml` must pass on Ubuntu, macOS, and Windows for
  changes that touch worker scheduling, DuckDB lifecycle, topology, SQLite/WAL
  handling, or progress reporting.

## Suggested PR Slices

1. Instrumentation only: per-chunk RSS and fanout diagnostics, no behavior
   change except bounded logging.
2. Adaptive scheduler: soft-cap behavior and fanout-aware chunk shrinking for
   native-heavy components.
3. Summary rewrite slice: SQL-native bounded accumulation and split
   publication.
4. Posting rewrite slice: fanout-aware posting batches and narrower merge
   shape.
5. Status/search cleanup: remove or cap remaining dirty-patch fanout paths.
6. Owner-light diagnostics/UI: recovery state and progress surfaces that remain
   fast under owner pressure.

Each slice should keep the previous safety net intact until the live current-DB
watch proves it is no longer exercised during ordinary drain.
