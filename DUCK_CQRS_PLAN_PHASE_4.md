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

## Implementation Readiness Review - 2026-06-18

- Verdict: Phase 4 is ready to start as an implementation backlog, but no production route is ready to mount yet. The next safe slice is non-mounted reader/job/search/parity implementation plus tests behind the existing `mounted: false` inventory.
- No Phase 4 production route migration appears complete. `reviewServingReadContractRouteInventory` has no `mounted: true` entries, and the target route handlers still use OLAP wrappers, direct DuckDB SQL, shared raw hydration helpers, or process-local PDF job state.
- Do not re-implement the Phase 3 foundation listed below. Phase 4 should build on it and only change a production route after that route's serving reader, parity, SQL-shape, budget, and browser/desktop gates pass.
- Phase 3 is not fully complete as of this review. Before any route inventory entry becomes `mounted: true`, close or explicitly re-scope the Phase 3 gaps recorded in `DUCK_CQRS_PLAN_PHASE_3.md`: base selected-import projector wiring, production projector worker scheduling, chunk/compaction/cleanup discovery, diagnostics/badge/queue contribution coverage, and the Phase 3 Effect rule decision.

## Already Implemented Foundation

| Area | Current Code | Phase 4 Use |
|---|---|---|
| Read contract registry and route inventory | `src/server/reviewServing/reviewServingReadContracts.ts` plus `reviewServingReadContracts.test.ts` | Use the existing contract keys, budgets, physical access strategies, surfaces, and conservative `mounted: false` entries. Do not mark an entry `mounted: true` until full product response parity is proven. |
| Serving state vocabulary | `src/server/reviewServing/reviewServingContracts.ts` | Reuse `ready`, `indexing`, `stale`, `unavailable` freshness states and `candidate`, `active`, `failed`, `retired` snapshot statuses in reader diagnostics. |
| Admission and workload context | `src/server/reviewServing/reviewServingAdmission.ts` plus tests | Route adapters and jobs should call this before DuckDB work. It already rejects budget excess, unsupported count state, stale snapshots without stale allowance, mismatched search modes, and synchronous substring search. |
| Cursor and filter signatures | `src/server/reviewServing/reviewServingCursor.ts` plus tests | Use these for projection-identity, snapshot, component-state, and filter-scoped cursors instead of route-local cursor parsing. |
| SQL-shape guard and serving SQL builder | `src/server/reviewServing/reviewServingSql.ts` and `reviewServingSqlForbiddenPatterns.ts` plus tests | Build serving-table queries through these helpers and assert no raw fallback tables, `OFFSET`, unregistered tables, missing project/snapshot scope, or missing limits. |
| Snapshot manifests, pins, and retention protection | `reviewServingManifestRepository.ts`, `reviewServingSnapshotPinRepository.ts`, `reviewServingRetentionService.ts` plus tests | Use manifest diagnostics for reader freshness and use pins for repeatable durable jobs. |
| V4 projector foundation | `reviewServingProjectorService.ts`, projector modules, and `src/server/workers/reviewServingProjectorWorker.ts` plus tests | Treat this as a partial writer/projection foundation until the Phase 3 audit gaps are closed. Phase 4 should not add raw read fallbacks when projections are unavailable. |
| Title-search projection and contracts | `reviewServingTitleSearchProjector.ts`, `mart.review_title_search_serving_v4`, and `review.search.tokenPrefix` / `review.search.substringAsync` contracts | Use token/prefix search for synchronous ready state and async/unavailable behavior for substring search until a benchmarked n-gram projection exists. |
| Durable job tables and contract references | DuckDB migration `0097_reviewServingV4Foundation.sql` creates `app.review_bulk_operation_job` and `app.review_search_job`; read contracts reference both tables | Build `reviewBulkOperationService`, `reviewBulkOperationWorker`, and `reviewSearchService` on these tables instead of introducing process-local state. |

## Missing Before Any Route Cutover

- `src/server/reviewServing/reviewServingReader.ts` with manifest lookup, admission, SQL-shape assertion, cursor handling, filter/search/count state handling, diagnostics, and no raw fallback path.
- `src/server/reviewServing/reviewBulkOperationService.ts` for select-all, add-to-project, PDF, and export criteria persistence, snapshot pinning or declared latest-snapshot semantics, keyset batching, cancellation, retry, and resume.
- `src/server/workers/reviewBulkOperationWorker.ts` for durable job execution over bounded batches.
- `src/server/reviewServing/reviewSearchService.ts` for ready token/prefix reads and async/unavailable substring behavior.
- Route-specific parity validation runner and semantic fixtures comparing `reviewServingReader` output to safe-size current behavior before each route switches.
- Serving-only route/job tests proving no raw fallback, no all-ID foreground materialization, no process-local job state, no large `OFFSET`, no synchronous substring scans, and full current response shape coverage.
- Browser review-flow verification for freshness diagnostics and desktop route-surface verification or desktop build for shared runtime changes.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Foreground serving reads | Build `reviewServingReader` on the existing read contracts, admission, cursor/filter signature, SQL-shape guard, and manifest diagnostics. Keep route inventory entries `mounted: false` until reader tests and route-specific parity pass, then migrate LLM, human, both, unassessed, filters, facets, badges, counts, rows, queues, detail reads, health/warnings, and prompt preview route by route. | Route tests prove serving-only reads, complete product response coverage for each serving-mounted route inventory entry, projection-identity/snapshot/filter-scoped cursors, bounded filter access, result caps, no raw fallback, no `OFFSET`, no JSON extraction/sorts, no project-wide windows, registry-based admission, and deletion or hard-disablement of the matching legacy path. |
| [ ] | Route-specific parity validation | Implement the parity runner before the first route mount, then run the new serving reader against semantic fixtures, invariant checks, benchmarks, and safe-size current behavior before each route or flow is migrated. | Parity checks pass for row payload semantics, named count states, freshness states, cursor behavior, SQL shape, latency budgets, result bytes, and no forbidden foreground DuckDB work before that production route switches. |
| [ ] | Bulk, export, PDF, and search jobs | Build durable services on the existing `app.review_bulk_operation_job` and `app.review_search_job` tables. Replace select-all/add-to-project/PDF/export all-ID materialization with durable keyset-batched jobs. Add token/prefix search and async-only substring behavior unless n-gram projection is benchmarked. | Bulk/search tests prove criteria/projection-identity/snapshot/filter signatures are persisted, repeatable jobs pin snapshots, batches are bounded, jobs resume/cancel/retry, and synchronous substring search scans are not admitted. |
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
- Bulk/PDF/export/add-to-project routes: `ArticlesRoutes.ts`, `ProjectExportRoutes.ts`, and `ProjectsAddArticlesRoutes.ts` for `/api/articles/pdf-fetch-by-filter`, `/api/articles/pdf-fetch-by-project`, `/api/articles/pdf-fetch-jobs/:jobId`, `/api/projects/:id/export`, `/api/projects/add_articles_by_filter`, and `/api/projects/add_articles_by_ids`.
- Explicit-ID PDF bulk route `/api/articles/pdf-fetch-bulk` is not a project-scoped review-serving inventory entry. It remains in Phase 4 job migration scope and must move to durable article-ID-only job admission with per-request ID and payload caps.
- Ambiguous adjacent surfaces must be classified before Phase 4 closes: `/api/articles/search`, `/api/articles/latest`, `/api/projects/:id/articles`, and `HumanAssessmentRoutes.ts` are either migrated to serving/job/admission behavior when they participate in review flows or explicitly marked out of scope/admin/debug with a reason.

### Current Route Implementation Check - 2026-06-18

- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`, `projectsRoutesGetArticlesReviewsCount.ts`, `projectsRoutesGetArticlesReviewsBoth.ts`, `projectsRoutesGetArticlesReviewsUnassessed.ts`, and `projectsRoutesGetArticlesReviewsFilters.ts` still call OLAP wrappers.
- `projectsRoutesGetArticlesReviewsHuman.ts`, `projectsRoutesGetArticlesReviewsHumanFilters.ts`, `projectsRoutesPostArticleReviewDetails.ts`, `projectsRoutesGetPromptPreview.ts`, `ArticlesRoutes.ts`, and `ProjectExportRoutes.ts` still contain direct DuckDB/app-query SQL or shared raw hydration paths that must move behind serving readers or job services before the related route is marked mounted.
- The current human review routes still use large candidate ID arrays and `OFFSET`; they need serving row/article-set/posting access before 10M-scale certification.
- The current PDF filter/project and add-to-project-by-filter paths still materialize all matching article IDs in the foreground request.
- `/api/articles/pdf-fetch-jobs/:jobId` currently reads `src/server/services/pdfFetchJobs.ts`, which stores jobs in an in-memory `Map`; Phase 4 durable jobs must replace this for migrated PDF flows.
- The public route-surface inventory already classifies `/api/articles/search`, `/api/articles/latest`, `/api/projects/:id/articles`, and `HumanAssessmentRoutes.ts` as product surfaces, but Phase 4 still needs a review-serving participation decision for each.

## Route Completeness Requirements

- `/api/articlesreviewscount` must not migrate until the serving count path covers the current duplicate/conflict/article-created-date/prompt scope and either supports search-scoped counts explicitly or returns explicit unavailable/async state for searched counts.
- `/api/articlesreviewsfilters` and `/api/articlesreviewshumanfilters` must not migrate through article posting rows alone. They need complete review-specific and human-specific facet plus filter-option/min-max response contracts, including active search scope and summary-mode human answer scope where the current route applies them.
- `/api/projectsreview` must not migrate until judgment-detail serving contracts cover prompt-level explanations, quotes, assessments, placeholder judgments, payload references, human prompt/summary fields, row metadata, badges, related-record/project-context extras, and freshness/diagnostic payloads.
- `/api/projectsreviewswarnings` must not migrate through snapshot manifests alone. It needs warning/health contracts for active refresh counts, usable manifest status, maintenance lease state, large-rebuild progress, quarantine warnings, and last-known-good/failed state.
- Review list routes must not mount until row contracts preserve row metadata, article timestamps, prompt-level LLM judgment arrays, human prompt/summary arrays, both-mode LLM and human payloads, prompt badges, and the current duplicate/conflict/article-created-date/prompt/search filter scopes.
- Filtered review list routes must use posting/search selection plus article-set hydration for rows and list judgment payloads. They must not hydrate filtered pages by replaying unfiltered ordered-prefix rows or by issuing N+1 single-article detail lookups.
- Posting contracts used by list routes must be constrained by list mode or split into per-list contracts before they are mounted.
- PDF-by-filter and PDF-by-project routes must not mount until list type, date bounds, duplicate/conflict filters, and search scope are represented in the selection contract. Explicit-ID PDF bulk routes must use article-ID-only job admission instead of project-scoped review-serving selection.
- Export routes must not mount until export contracts cover selected article metadata plus prompt answers, explanations, and quotes.
- Prompt preview must preserve the current sample-article order, prompt/config identity, model execution context, full-text preparation behavior, `no_fulltext` handling, and conversion-failure behavior before it is mounted.
- The health route plan must match the actual mounted route surface. If `/api/projectsreviewshealth` remains unmounted, keep its serving contract internal or fold its diagnostics into `/api/projectsreviewswarnings`; do not count it as a migrated production route.

## Job Migration Scope

- Select-all and add-to-project by filter use `reviewBulkOperationService` jobs instead of all-ID arrays.
- Add-to-project by explicit IDs uses durable article-ID-only admission with per-request ID and payload caps, or is explicitly capped and classified outside review-serving selection semantics.
- Add-to-project by filter uses a substring async selection contract when the product route receives substring search input; it must not certify substring behavior under token-prefix search semantics.
- PDF fetch uses durable bulk jobs with snapshot pins or declared latest-snapshot semantics.
- Project export uses serving/export jobs with projection-identity/snapshot/filter cursors, snapshot pins, and payload budgets.
- Ready title search uses token/prefix search projection.
- Unsupported substring search returns unavailable/search-indexing state or creates bounded async work over projected/searchable state.
- Synchronous substring scans over raw or large serving title state are not admitted at 10M scale unless a benchmarked n-gram projection is added.
- Explicit-ID PDF bulk requests use durable article-ID-only job admission with per-request ID and payload budgets. Filter/project PDF requests use persisted selection criteria and never materialize all matching IDs in the foreground request.
- Job routes and lookup routes, including `/api/articles/pdf-fetch-jobs/:jobId`, bind `job_kind`, filter signature, search mode/text when relevant, projection identity, snapshot pin or latest-snapshot semantics, `updated_at`, and `job_id`; they do not reuse article-row cursors for job-table pagination or in-memory process-local job state.

### Current Job Implementation Check - 2026-06-18

- The DuckDB schema and read contracts already include durable job tables, but the Phase 4 services and worker that write and execute those jobs do not exist yet.
- Existing PDF fetch jobs are process-local and receive foreground materialized ID arrays. Treat them as legacy for Phase 4 migrated PDF routes.
- Existing title-search projection support is available, but route/search service wiring still needs to enforce token/prefix ready reads and async/unavailable substring behavior at the API boundary.

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

## Required Artifacts And Current Status

| Status | Artifact | Notes |
|---|---|---|
| Missing | `src/server/reviewServing/reviewServingReader.ts` | First implementation target. It should compose existing contracts, admission, manifests, cursor/filter signatures, SQL builder, and diagnostics. |
| Missing | `src/server/reviewServing/reviewBulkOperationService.ts` | Should persist criteria and job identity in `app.review_bulk_operation_job`, not process-local memory or all-ID arrays. |
| Missing | `src/server/workers/reviewBulkOperationWorker.ts` | Should execute durable jobs in bounded keyset batches with cancellation, retry, resume, and progress state. |
| Missing | `src/server/reviewServing/reviewSearchService.ts` | Should enforce token/prefix ready search and async/unavailable substring behavior. |
| Missing | Route-specific parity validation runner/checks | Existing OLAP parity tests are not enough because they do not compare `reviewServingReader` responses. |
| Missing | Route tests for serving-only behavior and durable job creation | Required before any route inventory entry can become `mounted: true`. |
| Partially present | Static or route-surface tests for browser/desktop classification | Public route-surface inventory tests exist; Phase 4 still needs serving/job-specific browser and desktop verification for changed shared runtime paths. |

## Existing Supporting Gates

- `bun test src/server/reviewServing/reviewServingReadContracts.test.ts` already protects route inventory completeness and keeps incomplete entries unmounted.
- `bun test src/server/reviewServing/reviewServingAdmission.test.ts` already covers budget, freshness, count, search, and workload admission rules.
- `bun test src/server/reviewServing/reviewServingSql.test.ts` already covers serving SQL shape and forbidden patterns for helper-built queries.
- `bun test src/server/reviewServing/reviewServingCursor.test.ts` already covers projection-identity, snapshot, component-state, and filter-scoped cursor validation.
- Projector, manifest, pin, retention, schema, and title-search tests exist under `src/server/reviewServing` and should stay green while Phase 4 adds reader/job wiring.
- These supporting gates are prerequisites only; they do not replace the route-specific Phase 4 quality gates below.

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
- [ ] Targeted tests prove select-all, add-to-project by filter, PDF-by-filter/project, and export use durable jobs and keyset-batched execution without returning all matching article IDs; explicit-ID add-to-project and PDF bulk paths enforce article-ID-only caps or are explicitly classified outside review-serving selection semantics.
- [ ] Targeted tests prove durable job lookups, including `/api/articles/pdf-fetch-jobs/:jobId`, bind job kind, filter signature, search mode/text when relevant, and pinned or latest-snapshot semantics using job-table cursor fields instead of in-memory process-local state.
- [ ] Targeted tests prove repeatable durable jobs pin serving snapshots and cleanup skips pinned base/patch/payload/count/search state.
- [ ] Targeted tests prove foreground query admission rejects or serves stale for over-budget workload classes before DuckDB execution.
- [ ] Targeted tests prove foreground admission rejects mismatched search modes before DuckDB execution.
- [ ] Targeted tests prove route-specific parity validation blocks route migration on semantic fixture, invariant, sampled parity, cursor, freshness-state, SQL-shape, latency, or response-size mismatches.
- [ ] Browser review-flow verification for stale, indexing, and unavailable freshness states plus failed, candidate, retired, and missing snapshot diagnostics.
- [ ] Desktop route-surface verification or targeted desktop build when shared runtime paths change.
- [ ] `bun run lint`
