# Review-Serving Continuous Completion Plan

Date: 2026-09-15

## Goal

Make newly judged articles appear continuously and correctly on project review
pages, especially `reviews-llm?llmStatus=complete`, without rebuilding full
review-serving marts or falling back to broad raw judgment queries.

Completed rows, counts, pagination, and badges should converge from the same
incremental serving state. A running judgment job should only need to advance
small dirty-work patches for the affected articles and cache dependencies.

## Current Findings

- Judgment job SQLite outbox import is already fast enough for the observed
  project. Job rows are reaching DuckDB and `app.review_change_delta`.
- `llmStatus` dirty work is applying to
  `mart.review_article_serving_list_mode_state_v4`; direct serving state showed
  more than 1,400 complete LLM rows while the public count route still returned
  450.
- `/api/articlesreviews` row reads use direct base/list-mode state and can show
  completed rows once `llmStatus` dirty work applies.
- `/api/articlesreviewscount` can return stale positive values from
  `mart.review_filtered_count_serving_v4`.
- The filtered-count cache key currently depends on snapshot manifest component
  identity. Dirty `llmStatus` patches update row state, but the active snapshot
  manifest still has `llmStatus.patchWatermark = 0`, so a cached count can stay
  valid forever from the cache's point of view.
- Search and prompt-answer posting work should not block bare `llmStatus`
  complete/partial rows or counts when no search/prompt-answer filter is active.

## Non-Goals

- Do not recompute full review-serving marts after each judgment.
- Do not make the review page read raw `app.judgment` broadly for normal rows or
  counts.
- Do not hide stale counts by returning `null` totals when exact incremental
  state is available.
- Do not add a time-based cache TTL as the main correctness mechanism. TTLs can
  reduce stale duration, but they do not model serving freshness.
- Do not make search or prompt-answer filter readiness part of the bare
  `llmStatus=complete` path.

## Recommended Architecture

### 1. Treat `llmStatus` Dirty Patches As A Versioned Serving Component

Add a monotonic freshness token for dirty `llmStatus` state. This can be a
component patch watermark, source-high-watermark revision, or compact
component-revision table, but it must advance when dirty `llmStatus` work changes
active serving rows.

Requirements:

- Increment after successful, transactional application of dirty `llmStatus`
  patches.
- Be scoped by project, snapshot/review config, list-mode-relevant projection
  identity, and component.
- Be cheap to read from foreground count routes.
- Not require writing a brand-new snapshot manifest for each judgment if a
  smaller component-revision table is safer.
- Preserve evidence for failed or partially applied dirty work.

### 2. Use Direct State Counts For Simple Status Filters

For simple state-only filters, count from serving state directly:

- `llmStatus=complete`
- `llmStatus=partial`
- `llmHasJudgment=true`
- corresponding human/both state filters where the same principle applies

The source should be the already-incremental direct state join:

- `mart.review_article_serving_base_v4`
- `mart.review_article_serving_list_mode_state_v4`

This avoids cached stale totals for the common page modes and does not touch raw
judgment tables.

### 3. Keep Filtered-Count Cache For Expensive Count Shapes

Continue using `mart.review_filtered_count_serving_v4` for expensive count
shapes, including:

- prompt-answer filters
- search filters
- duplicate/conflict filters combined with prompt/search filters
- multi-group posting intersections

But key those cache rows by the actual dependency revisions used by the query.
For example:

- filter signature
- project id, snapshot id, review config hash, list mode
- `llmStatus` revision when the query uses LLM state
- `humanStatus` revision when the query uses human state
- `posting` revision when the query uses posting buckets
- `search` revision when the query uses search
- `queue` revision when the query uses unassessed queue state

If a dependency changes, the cache should miss naturally and recompute only that
filtered count, not rebuild the marts.

### 4. Prioritize Fresh Status Dirty Work

Fresh `llmStatus` dirty work from active judgment jobs should run ahead of bulk
search, summary, and secondary posting work. It is small, user-visible, and
drives page membership.

Do not let this starve safety or ownership work, but do let it bypass large
background rebuild backlogs where possible.

### 5. Optional Prewarming

After `llmStatus` dirty work advances, optionally prewarm the most common counts:

- LLM complete
- LLM partial
- human reviewed/unreviewed, if applicable
- both/conflict summaries only if cheap

Prewarming is an optimization, not a correctness dependency. Foreground reads
must remain correct on cache miss.

## Implementation Plan

### Phase 1: Baseline And Regression Fixtures

- Add a regression fixture where:
  - a project has an active snapshot,
  - `review_article_serving_list_mode_state_v4` starts with 450 answered rows,
  - `review_filtered_count_serving_v4` contains a stale positive `450` count,
  - dirty `llmStatus` patches make additional active rows `answered`,
  - `/api/articlesreviewscount` for `llmStatus=complete` must return the direct
    current state count, not the stale cached count.
- Add a route/service regression for page rows and count agreeing after dirty
  status patches.
- Add a negative regression proving prompt-answer/search filtered counts still
  use the expensive-count cache path or lazy posting path where appropriate.

Acceptance criteria:

- The stale positive cache case fails before the fix.
- The test does not rely on sleeping or TTL expiry.
- The fixture does not query raw judgments for the normal count path.

### Phase 2: Direct State Counts For Simple Status Filters

- Teach filtered count selection to identify state-only count requests.
- Bypass `mart.review_filtered_count_serving_v4` for those state-only requests.
- Count directly from base + list-mode state with the same predicates as row
  reads.
- Keep article date predicates, list mode membership, duplicate/conflict state,
  and `llmStatus`/`humanStatus` semantics aligned with row reads.
- Keep prompt-answer and search filters on the existing filtered-count path.

Acceptance criteria:

- `llmStatus=complete` count updates as soon as direct state changes.
- Counts and rows agree for first page, later cursors, and total pages.
- The route still returns exact counts when details/payload/search are not ready
  but direct status state is ready.

### Phase 3: Component Revision For Dirty Status Patches

- Choose the storage shape:
  - update component patch watermark in a small component revision table, or
  - safely update manifest component state when dirty patches apply.
- The revision must advance only after the dirty patch transaction commits.
- Expose the revision through existing manifest/component identity helpers or a
  small companion lookup used by filtered-count cache identity.
- Include enough source watermark detail to distinguish project-wide rebuild
  state from job/outbox dirty patches.

Acceptance criteria:

- Dirty `llmStatus` patches advance a foreground-readable revision.
- Revision advancement is atomic with dirty-work ACK/source watermark updates.
- Failed or rolled-back dirty patches do not advance the revision.
- Revision reads are bounded by project/snapshot/component, not a broad dirty
  table scan.

### Phase 4: Revision-Keyed Filtered Count Cache

- Extend filtered-count component identity to include only dependency revisions
  required by the filter shape.
- Keep the cache for expensive counts.
- Prune or naturally retire old cache rows keyed by obsolete identity.
- Avoid backward-compatibility shims for old cache identity; this is derived
  intermediate state and can be safely rebuilt.

Acceptance criteria:

- A cached count for `llmStatus=complete` cannot survive an `llmStatus` revision
  change if that route still uses cache in any path.
- Prompt-answer filtered count cache misses after affected posting/status
  revisions change.
- Unrelated dependency changes do not invalidate a count unnecessarily.

### Phase 5: Scheduler Priority For Fresh Status Work

- Ensure job-driven `llmStatus` dirty work is admitted before bulk search,
  summary, and secondary posting rebuild work when both are pending.
- Keep existing owner-stall protections: bounded batches, no large multi-range
  writer transactions, and live API responsiveness checks.
- Add diagnostics showing source partition high-watermark lag for
  `judgmentSqliteOutboxImport:*` sources.

Acceptance criteria:

- On a running judgment job, source import high-watermark and `llmStatus`
  completed high-watermark stay close under normal load.
- Search/summary backlog does not prevent completed article membership from
  updating.
- Foreground review routes remain responsive while the job runs.

### Phase 6: UI State And Operator Diagnostics

- Keep the visible page based on rows/counts from serving state.
- If import is ahead of serving projection, optionally show a compact
  "judged, indexing into review page" signal.
- Add diagnostics for:
  - imported judgment high-watermark,
  - `llmStatus` dirty completed/pending high-watermark,
  - direct state complete/partial counts,
  - cached filtered-count rows and dependency identity.

Acceptance criteria:

- The UI does not show completed count as frozen when direct state has advanced.
- Operators can tell whether lag is import, dirty projection, cache invalidation,
  or sort position.

## Regression Tests

Add or update focused tests near the source they protect.

### Count Cache And Dynamic Count SQL

Commands:

```sh
bun test src/server/reviewServing/reviewServingFilteredCountService.test.ts src/server/reviewServing/reviewServingDynamicCountSql.test.ts --timeout 120000
```

Coverage:

- filtered-count cache identity includes required dependency revisions;
- old positive cached count is ignored after relevant status revision changes;
- simple `llmStatus=complete` and `partial` counts use direct state;
- expensive prompt-answer/search counts continue to use cached/lazy paths;
- zero-count behavior remains non-sticky as currently intended.

### LLM Review Route Service

Commands:

```sh
bun test src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts --timeout 120000
```

Coverage:

- `/api/articlesreviews` and `/api/articlesreviewscount` agree after dirty
  `llmStatus` patches;
- stale filtered-count cache row cannot keep totalCount at 450 when direct state
  has more complete rows;
- `isFullyJudged` still uses serving `llm_status` as source of truth;
- prompt-answer filtered fallback still works while posting buckets index;
- nullable totals still occur only for truly missing required runtime components,
  not for stale status counts.

### Reader And SQL Contracts

Commands:

```sh
bun test src/server/reviewServing/reviewServingSql.test.ts src/server/reviewServing/reviewServingReader.test.ts --timeout 120000
```

Coverage:

- row and count predicates share list-mode membership and date semantics;
- state-only counts do not add search/posting requirements;
- search filters still require search readiness;
- prompt-answer filters still require posting/lazy fallback behavior;
- cursor/page rows remain sorted and stable.

### Dirty Status Projection

Commands:

```sh
bun test src/server/reviewServing/reviewServingLlmStatusProjector.test.ts src/server/reviewServing/reviewServingProjectorWriter.test.ts --timeout 120000
```

Coverage:

- dirty `llmStatus` patch updates list-mode state and advances component
  revision atomically;
- dirty-work ACK/source watermark and component revision commit together;
- rollback leaves state, ACK, and revision unchanged;
- deleted/tombstoned judgments move status back to partial/unanswered and
  invalidate dependent counts;
- project model/content-setting identity remains enforced for judgment status.

### Worker Scheduling And Current Backlogs

Commands:

```sh
bun test src/server/workers/reviewServingProjectorWorker.test.ts --timeout 120000
```

Coverage:

- fresh job-driven `llmStatus` dirty work is not starved behind search/summary
  backlog;
- small bounded batches stay within owner responsiveness constraints;
- selected-import and search anti-stall protections remain intact;
- diagnostics expose dirty high-watermark lag by source partition.

### Route Boundaries

Commands:

```sh
bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.test.ts src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts --timeout 120000
```

Coverage:

- public count route forwards `llmStatus` filters correctly;
- route-level response shape remains stable;
- OLAP/serving parity expectations remain explicit for status filters;
- invalid body validation remains unchanged.

### Frontend Query And Pagination Behavior

Commands:

```sh
bunx vitest run src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTable.vitest.tsx src/components/main/reviews/reviewsArticleQueryGating.test.ts
```

Coverage:

- complete/partial filter changes invalidate the right TanStack queries;
- count and row queries are requested with the same `llmStatus` filter;
- pagination/cursor UI reacts to updated total pages;
- partial badges do not reappear on complete-filter rows.

### Live Current-DB Verification

Use the primary runtime through the owner-backed APIs, not a direct DuckDB open.

Required checks:

- API and DuckDB owner ready.
- For the target project, sample:
  - running job import high-watermark,
  - `llmStatus` dirty completed/pending high-watermark,
  - direct active state complete count,
  - `/api/articlesreviewscount` complete total,
  - `/api/articlesreviews` complete first page.
- Confirm:
  - direct state and route count agree after dirty `llmStatus` catches up;
  - rows are all `isFullyJudged=true` under `llmStatus=complete`;
  - no broad search/summary rebuild is required for bare complete counts;
  - foreground route latency stays acceptable while the judgment job runs.

## Quality Gates

Minimum before merging:

```sh
bun test src/server/reviewServing/reviewServingFilteredCountService.test.ts src/server/reviewServing/reviewServingDynamicCountSql.test.ts --timeout 120000
bun test src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts --timeout 120000
bun test src/server/reviewServing/reviewServingSql.test.ts src/server/reviewServing/reviewServingReader.test.ts --timeout 120000
bun test src/server/reviewServing/reviewServingLlmStatusProjector.test.ts src/server/reviewServing/reviewServingProjectorWriter.test.ts --timeout 120000
bun test src/server/workers/reviewServingProjectorWorker.test.ts --timeout 120000
bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.test.ts src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts --timeout 120000
bunx vitest run src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTable.vitest.tsx src/components/main/reviews/reviewsArticleQueryGating.test.ts
git diff --check
```

Live gate:

- Verify the current project with a running or recently completed judgment job.
- Include before/after evidence for import high-watermark, `llmStatus`
  high-watermark, direct complete state count, API complete count, and first-page
  row status.
- Confirm route latency remains acceptable and the DuckDB owner stays ready.

## Rollout Notes

- This touches server, database intermediate state, worker scheduling, and client
  query behavior.
- Existing `mart.review_filtered_count_serving_v4` rows are derived cache state.
  Prefer pruning/rebuilding derived rows over compatibility shims if the cache
  identity changes.
- Browser and desktop share the API and TanStack query path, so both should be
  considered. A browser verification is sufficient for the shared review page
  behavior unless desktop runtime wiring changes.
- If a migration adds a component revision table or columns, run `bun run
  db:mig` and include the migration tests relevant to the touched schema.
