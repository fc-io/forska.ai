# DuckDB CQRS Plan Phase 4 - Serving Reads, Parity, Jobs, And Usage Migration

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Move production review reads and bulk/search/export/PDF behavior behind serving readers and durable jobs. Remove each matching legacy route path as soon as that route or flow passes its serving, parity, SQL-shape, budget, and relevant browser/desktop gates.

## Cut Line

Migrate production route handlers and durable job paths to serving/job services one route or flow at a time. When a route or flow is migrated, delete or hard-disable its matching raw fallback path in the same change unless it is explicitly reclassified as admin/maintenance/debug-only.

Route-specific parity validation blocks that route migration on semantic mismatch, invariant failure, forbidden SQL shape, latency budget breach, response-size budget breach, or relevant browser/desktop verification failure.

## Current Baseline After Phase 3

- Phase 3 serving foundations exist: read contracts, contract inventory, admission, cursor/filter signatures, SQL-shape guards, projector writer/services, snapshot pins, title-search projection, and the serving projector worker.
- Product review routes are not serving-mounted yet. In `reviewServingReadContractRouteInventory`, `mounted: false` means the HTTP route is not production-serving-backed yet, not that the HTTP route is absent.
- The missing Phase 4 boundaries are still `reviewServingReader.ts`, `reviewBulkOperationService.ts`, `reviewBulkOperationWorker.ts`, `reviewSearchService.ts`, route-specific serving parity checks, and serving-only route/job tests.
- Serving-shaped branches that still live in `duckdbOlap.ts`, OLAP wrappers, route handlers, or shared raw hydration helpers remain legacy until moved behind `reviewServingReader` with no raw fallback decision path.
- The implemented state vocabulary is `ready`, `indexing`, `stale`, and `unavailable` for freshness; `candidate`, `active`, `failed`, and `retired` are snapshot statuses that reader diagnostics must expose without treating failed or candidate snapshots as readable freshness states.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Foreground serving reads | Build `reviewServingReader` on the existing read contracts, admission, cursor/filter signature, SQL-shape guard, and manifest diagnostics, then migrate LLM, human, both, unassessed, filters, facets, badges, counts, rows, queues, detail reads, health/warnings, and prompt preview to it. | Route tests prove serving-only reads, complete product response coverage for each serving-mounted route inventory entry, projection-identity/snapshot/filter-scoped cursors, bounded filter access, result caps, no raw fallback, no `OFFSET`, no JSON extraction/sorts, no project-wide windows, registry-based admission, and deletion or hard-disablement of the matching legacy path. |
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
- Shared legacy helpers and OLAP wrappers: `duckdbOlap.ts`, `articlesReviewsOlap.ts`, `scopedArticleReadAdapter.ts`, and any remaining route-side SQL that builds `selected_scoped_article_import`, decodes review cursors, computes filter signatures, or decides raw fallback.
- Bulk/PDF/export/add-to-project routes: `ArticlesRoutes.ts`, `ProjectExportRoutes.ts`, and `ProjectsAddArticlesRoutes.ts` for `/api/articles/pdf-fetch-bulk`, `/api/articles/pdf-fetch-by-filter`, `/api/articles/pdf-fetch-by-project`, `/api/projects/:id/export`, and `/api/projects/add_articles_by_filter`.
- Ambiguous adjacent surfaces must be classified before Phase 4 closes: `/api/articles/search`, `/api/articles/latest`, `/api/projects/:id/articles`, and `HumanAssessmentRoutes.ts` are either migrated to serving/job/admission behavior when they participate in review flows or explicitly marked out of scope/admin/debug with a reason.

## Route Completeness Requirements

- `/api/articlesreviewscount` must not migrate until the serving count path covers the current duplicate/conflict/article-created-date/prompt scope and either supports search-scoped counts explicitly or returns explicit unavailable/async state for searched counts.
- `/api/articlesreviewsfilters` and `/api/articlesreviewshumanfilters` must not migrate through article posting rows alone. They need complete review-specific and human-specific facet plus filter-option/min-max response contracts, including active search scope and summary-mode human answer scope where the current route applies them.
- `/api/projectsreview` must not migrate until judgment-detail serving contracts cover prompt-level explanations, quotes, assessments, placeholder judgments, payload references, human prompt/summary fields, row metadata, badges, related-record/project-context extras, and freshness/diagnostic payloads.
- `/api/projectsreviewswarnings` must not migrate through snapshot manifests alone. It needs warning/health contracts for active refresh counts, usable manifest status, maintenance lease state, large-rebuild progress, quarantine warnings, and last-known-good/failed state.
- Review list routes must not mount until row contracts preserve row metadata, article timestamps, prompt-level LLM judgment arrays, human prompt/summary arrays, both-mode LLM and human payloads, prompt badges, and the current duplicate/conflict/article-created-date/prompt/search filter scopes.
- Filtered review list routes must use posting/search selection plus article-set hydration for rows and list judgment payloads. They must not hydrate filtered pages by replaying unfiltered ordered-prefix rows or by issuing N+1 single-article detail lookups.
- Posting contracts used by list routes must be constrained by list mode or split into per-list contracts before they are mounted.
- PDF-by-filter and PDF-by-project routes must not mount until list type, date bounds, duplicate/conflict filters, and search scope are represented in the selection contract. Explicit-ID PDF bulk routes must use an article-ID-only contract instead of project-scoped review-serving selection.
- Export routes must not mount until export contracts cover selected article metadata plus prompt answers, explanations, and quotes.
- Prompt preview must preserve the current sample-article order, prompt/config identity, model execution context, full-text preparation behavior, `no_fulltext` handling, and conversion-failure behavior before it is mounted.
- The health route plan must match the actual mounted route surface. If `/api/projectsreviewshealth` remains unmounted, keep its serving contract internal or fold its diagnostics into `/api/projectsreviewswarnings`; do not count it as a migrated production route.

## Job Migration Scope

- Select-all and add-to-project use `reviewBulkOperationService` jobs instead of all-ID arrays.
- Add-to-project by filter uses a substring async selection contract when the product route receives substring search input; it must not certify substring behavior under token-prefix search semantics.
- PDF fetch uses durable bulk jobs with snapshot pins or declared latest-snapshot semantics.
- Project export uses serving/export jobs with projection-identity/snapshot/filter cursors, snapshot pins, and payload budgets.
- Ready title search uses token/prefix search projection.
- Unsupported substring search returns unavailable/search-indexing state or creates bounded async work over projected/searchable state.
- Synchronous substring scans over raw or large serving title state are not admitted at 10M scale unless a benchmarked n-gram projection is added.
- Explicit-ID PDF bulk requests use an article-ID-only job contract with per-request ID and payload budgets. Filter/project PDF requests use persisted selection criteria and never materialize all matching IDs in the foreground request.
- Job routes and lookup routes bind `job_kind`, filter signature, search mode/text when relevant, projection identity, snapshot pin or latest-snapshot semantics, `updated_at`, and `job_id`; they do not reuse article-row cursors for job-table pagination.

## Serving Reader Rules

- Migrated routes call `reviewServingReader` or job services instead of `duckdbOlap.ts`.
- A route is not considered migrated when only helper contracts cover part of its current response. The mounted route inventory entry must match the full current product semantics or explicitly return unavailable/async states for unsupported pieces.
- A route inventory entry marked `mounted: true` means serving-backed production route coverage. `mounted: false` entries can still describe existing HTTP routes that are not migrated yet.
- Migrated route handlers do not call `runDuckdbJsonQuery`, build DuckDB SQL, decode review cursors, compute filter signatures, or decide raw fallback.
- Migrated routes remove or hard-disable the matching legacy raw/OLAP path in the same change unless it is explicitly reclassified as admin/maintenance/debug-only.
- Responses include explicit freshness/count/search/job states.
- Stale, indexing, or unavailable freshness states and failed, candidate, retired, or missing snapshot diagnostics do not trigger raw fallback.
- Every synchronous filter combination uses an ordered prefix, posting/projection table, bounded candidate set, or unavailable/async state.
- Direct row contracts and posting/article-set hydration contracts must preserve stable list-mode and article-ID tie-break ordering so keyset cursors match route semantics.
- Product list routes use keyset pagination and never require large `OFFSET`.
- Detail payloads are keyed and capped, not hydrated by default into hot list responses.
- Browser and desktop route surfaces share the same serving/job/admission behavior.

## Internal Parity Rules

- Compare semantic fixtures, sampled safe-size parity, invariants, freshness states, cursors, SQL shape, latency, and result-size behavior.
- Block each route or flow migration on any mismatch, forbidden SQL shape, unregistered foreground DuckDB work, or budget breach.
- Parity mode can run behind internal wiring before the route switches, but the route should switch and delete legacy as soon as its gates pass.
- Existing OLAP forwarding/parity tests are not the Phase 4 serving parity gate. The Phase 4 runner must compare `reviewServingReader` responses and diagnostics against semantic fixtures and safe-size current behavior.

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
- [ ] Route tests prove filtered list routes use posting/search selection plus article-set row and payload hydration, with no N+1 single-article lookup path.
- [ ] Route tests prove list row responses preserve current article timestamps or explicitly hydrate them through a capped companion contract before route inventory entries are mounted.
- [ ] Route tests prove PDF and export product routes preserve explicit-ID, list-type, article metadata, and prompt-output semantics before they are mounted.
- [ ] Targeted tests for filter contracts prove every synchronous filter combination uses ordered-prefix, posting/projection, or bounded-candidate access with maintained selectivity stats.
- [ ] Targeted tests prove posting contracts used by list routes are list-mode constrained.
- [ ] Targeted tests for token/prefix search behavior and async/unavailable substring behavior prove substring search never runs as a synchronous full-table scan.
- [ ] Targeted tests for projection-identity/snapshot/filter-scoped cursors and cursor-invalid behavior after identity/snapshot/component-state/filter mismatch.
- [ ] Targeted tests for hard route result-size caps: max page size, max response bytes, max hydrated payload bytes, and max per-request ID count.
- [ ] Targeted tests prove stale, indexing, or unavailable freshness states and failed, candidate, retired, or missing snapshot diagnostics do not trigger raw fallback.
- [ ] Targeted tests prove select-all, add-to-project, PDF fetch, and export use durable jobs and keyset-batched execution without returning all matching article IDs.
- [ ] Targeted tests prove durable job lookups bind job kind, filter signature, search mode/text when relevant, and pinned or latest-snapshot semantics using job-table cursor fields.
- [ ] Targeted tests prove repeatable durable jobs pin serving snapshots and cleanup skips pinned base/patch/payload/count/search state.
- [ ] Targeted tests prove foreground query admission rejects or serves stale for over-budget workload classes before DuckDB execution.
- [ ] Targeted tests prove foreground admission rejects mismatched search modes before DuckDB execution.
- [ ] Targeted tests prove route-specific parity validation blocks route migration on semantic fixture, invariant, sampled parity, cursor, freshness-state, SQL-shape, latency, or response-size mismatches.
- [ ] Browser review-flow verification for stale/indexing/failed/missing states.
- [ ] Desktop route-surface verification or targeted desktop build when shared runtime paths change.
- [ ] `bun run lint`
