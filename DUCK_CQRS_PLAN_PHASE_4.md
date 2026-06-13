# DuckDB CQRS Plan Phase 4 - Serving Reads, Parity, Jobs, And Usage Migration

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Move production review reads and bulk/search/export/PDF behavior behind serving readers and durable jobs. Remove each matching legacy route path as soon as that route or flow passes its serving, parity, SQL-shape, budget, and relevant browser/desktop gates.

## Cut Line

Migrate production route handlers and durable job paths to serving/job services one route or flow at a time. When a route or flow is migrated, delete or hard-disable its matching raw fallback path in the same change unless it is explicitly reclassified as admin/maintenance/debug-only.

Route-specific parity validation blocks that route migration on semantic mismatch, invariant failure, forbidden SQL shape, latency budget breach, response-size budget breach, or relevant browser/desktop verification failure.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Foreground serving reads | Migrate LLM, human, both, unassessed, filters, facets, badges, counts, rows, queues, detail reads, health/warnings, and prompt preview to `reviewServingReader`. | Route tests prove serving-only reads, complete product response coverage for each mounted route inventory entry, projection-identity/snapshot/filter-scoped cursors, bounded filter access, result caps, no raw fallback, no `OFFSET`, no JSON extraction/sorts, no project-wide windows, registry-based admission, and deletion or hard-disablement of the matching legacy path. |
| [ ] | Route-specific parity validation | Run the new serving reader against semantic fixtures, invariant checks, benchmarks, and safe-size current behavior before each route or flow is migrated. | Parity checks pass for row payload semantics, named count states, freshness states, cursor behavior, SQL shape, latency budgets, result bytes, and no forbidden foreground DuckDB work before that production route switches. |
| [ ] | Bulk, export, PDF, and search jobs | Replace select-all/add-to-project/PDF/export all-ID materialization with durable keyset-batched jobs. Add token/prefix search and async-only substring behavior unless n-gram projection is benchmarked. | Bulk/search tests prove criteria/projection-identity/snapshot/filter signatures are persisted, repeatable jobs pin snapshots, batches are bounded, jobs resume/cancel/retry, and synchronous substring search scans are not admitted. |
| [ ] | DuckDB usage migration | Resolve every row in the DuckDB usage migration inventory. | Each current review-related DuckDB use delegates to serving/admission/job logic or is explicitly marked admin/maintenance/debug-only. |

## Read Migration Scope

- LLM review routes: `projectsRoutesGetArticlesReviews.ts`, `projectsRoutesGetArticlesReviewsCount.ts`
- Both review routes: `projectsRoutesGetArticlesReviewsBoth.ts` and both-list logic in `duckdbOlap.ts`
- Human review routes: `projectsRoutesGetArticlesReviewsHuman.ts`, `projectsRoutesGetArticlesReviewsHumanFilters.ts`
- Unassessed and queue routes: `projectsRoutesGetArticlesReviewsUnassessed.ts`, `JudgmentsJobsRoutes.ts`, `judgmentsJobsCronGetPrompts.ts`
- Filter/facet routes: `projectsRoutesGetArticlesReviewsFilters.ts`, `projectsRoutesGetArticlesReviewsHumanFilters.ts`
- Detail/hydration routes: `projectsRoutesPostArticleReviewDetails.ts`, `ArticlesRoutes.ts` detail reads, `appQueryServiceCore.ts` article hydration helpers
- Health/warnings/prompt preview: `projectsRoutesGetReviewsHealth.ts`, `projectsRoutesGetReviewsWarnings.ts`, `projectsRoutesGetPromptPreview.ts`

## Route Completeness Requirements

- `/api/articlesreviewscount` must not migrate until the serving count path covers the current duplicate/conflict/date/prompt/search scope or returns explicit unavailable/async count state for unsupported combinations.
- `/api/articlesreviewsfilters` and `/api/articlesreviewshumanfilters` must not migrate through article posting rows alone. They need complete filter-option/min-max response contracts, including active search scope where the current route applies `query.search`.
- `/api/projectsreview` must not migrate until judgment-detail serving contracts cover prompt-level explanations, quotes, assessments, placeholder judgments, payload references, row metadata, and badges.
- `/api/projectsreviewswarnings` must not migrate through snapshot manifests alone. It needs warning/health contracts for active refresh counts, maintenance lease state, large-rebuild progress, quarantine warnings, and snapshot status.
- Review list routes must not mount until row contracts preserve prompt-level judgment arrays and the current duplicate/conflict/date/prompt/search filter scopes.
- Posting contracts used by list routes must be constrained by list mode or split into per-list contracts before they are mounted.
- PDF-by-filter and PDF-by-project routes must not mount until list type, date bounds, and search scope are represented in the selection contract. Explicit-ID PDF bulk routes must use an article-ID-only contract instead of project-scoped review-serving selection.
- Export routes must not mount until export contracts cover selected article metadata plus prompt answers, explanations, and quotes.
- Prompt preview must preserve the current sample-article order, full-text preparation behavior, `no_fulltext` handling, and conversion-failure behavior before it is mounted.

## Job Migration Scope

- Select-all and add-to-project use `reviewBulkOperationService` jobs instead of all-ID arrays.
- PDF fetch uses durable bulk jobs with snapshot pins or declared latest-snapshot semantics.
- Project export uses serving/export jobs with projection-identity/snapshot/filter cursors, snapshot pins, and payload budgets.
- Ready title search uses token/prefix search projection.
- Unsupported substring search returns unavailable/search-indexing state or creates bounded async work over projected/searchable state.
- Synchronous substring scans over raw or large serving title state are not admitted at 10M scale unless a benchmarked n-gram projection is added.

## Serving Reader Rules

- Migrated routes call `reviewServingReader` or job services instead of `duckdbOlap.ts`.
- A route is not considered migrated when only helper contracts cover part of its current response. The mounted route inventory entry must match the full current product semantics or explicitly return unavailable/async states for unsupported pieces.
- Migrated route handlers do not call `runDuckdbJsonQuery`, build DuckDB SQL, decode review cursors, compute filter signatures, or decide raw fallback.
- Migrated routes remove or hard-disable the matching legacy raw/OLAP path in the same change unless it is explicitly reclassified as admin/maintenance/debug-only.
- Responses include explicit freshness/count/search/job states.
- Stale, indexing, failed, and missing serving states do not trigger raw fallback.
- Every synchronous filter combination uses an ordered prefix, posting/projection table, bounded candidate set, or unavailable/async state.
- Product list routes use keyset pagination and never require large `OFFSET`.
- Detail payloads are keyed and capped, not hydrated by default into hot list responses.
- Browser and desktop route surfaces share the same serving/job/admission behavior.

## Internal Parity Rules

- Compare semantic fixtures, sampled safe-size parity, invariants, freshness states, cursors, SQL shape, latency, and result-size behavior.
- Block each route or flow migration on any mismatch, forbidden SQL shape, unregistered foreground DuckDB work, or budget breach.
- Parity mode can run behind internal wiring before the route switches, but the route should switch and delete legacy as soon as its gates pass.

## JavaScript And TypeScript Rule

Use the `effect` library for non-trivial JavaScript/TypeScript async and server flow in Phase 4 readers, route adapters, durable jobs, workers, search, export/PDF, and parity validation. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for service wiring, `Effect.acquireRelease`/`Scope` for resource lifetime, and `Schedule` for retries, polling, and backoff. Keep pure transforms and very small handlers as plain functions.

## Required Artifacts

- `src/server/reviewServing/reviewServingReader.ts`
- `src/server/reviewServing/reviewBulkOperationService.ts`
- `src/server/workers/reviewBulkOperationWorker.ts`
- `src/server/reviewServing/reviewSearchService.ts`
- Route-specific parity validation runner/checks
- Route tests for serving-only behavior and durable job creation
- Static or route-surface tests for browser/desktop classification

## Quality Gates

- [ ] `bun test src/server/reviewServing`
- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] Route tests prove each migrated LLM, human, both, unassessed, filter, count, badge, row, queue, bulk, PDF, and export route does not include raw fallback, `selected_scoped_article_import`, raw project-wide scans, large ID arrays, or large-offset pagination.
- [ ] Route inventory tests prove `mounted: true` entries cover the full product response shape and do not mark partial helper contracts as migrated routes.
- [ ] Route tests prove standalone count, filter-option, detail, warning, and prompt-preview routes preserve current semantics or return explicit unavailable/async state for unsupported pieces.
- [ ] Route tests prove list routes preserve judgment arrays plus duplicate/conflict/date/prompt/search filter scope before they are mounted.
- [ ] Route tests prove PDF and export product routes preserve explicit-ID, list-type, article metadata, and prompt-output semantics before they are mounted.
- [ ] Targeted tests for filter contracts prove every synchronous filter combination uses ordered-prefix, posting/projection, or bounded-candidate access with maintained selectivity stats.
- [ ] Targeted tests prove posting contracts used by list routes are list-mode constrained.
- [ ] Targeted tests for token/prefix search behavior and async/unavailable substring behavior prove substring search never runs as a synchronous full-table scan.
- [ ] Targeted tests for projection-identity/snapshot/filter-scoped cursors and cursor-invalid behavior after identity/snapshot/component-state/filter mismatch.
- [ ] Targeted tests for hard route result-size caps: max page size, max response bytes, max hydrated payload bytes, and max per-request ID count.
- [ ] Targeted tests prove stale, indexing, failed, and missing serving states do not trigger raw fallback.
- [ ] Targeted tests prove select-all, add-to-project, PDF fetch, and export use durable jobs and keyset-batched execution without returning all matching article IDs.
- [ ] Targeted tests prove repeatable durable jobs pin serving snapshots and cleanup skips pinned base/patch/payload/count/search state.
- [ ] Targeted tests prove foreground query admission rejects or serves stale for over-budget workload classes before DuckDB execution.
- [ ] Targeted tests prove foreground admission rejects mismatched search modes before DuckDB execution.
- [ ] Targeted tests prove route-specific parity validation blocks route migration on semantic fixture, invariant, sampled parity, cursor, freshness-state, SQL-shape, latency, or response-size mismatches.
- [ ] Browser review-flow verification for stale/indexing/failed/missing states.
- [ ] Desktop route-surface verification or targeted desktop build when shared runtime paths change.
- [ ] `bun run lint`
