# DuckDB CQRS Plan Phase 4 - Serving Reads, Parity, Jobs, And Usage Migration

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Move production review reads and bulk/search/export/PDF behavior behind serving readers and durable jobs. Remove each matching legacy route path as soon as that route or flow passes its serving, parity, SQL-shape, budget, and relevant browser/desktop gates.

## Cut Line

Migrate production route handlers and durable job paths to serving/job services one route or flow at a time. When a route or flow is migrated, delete or hard-disable its matching raw fallback path in the same change unless it is explicitly reclassified as admin/maintenance/debug-only.

Route-specific parity validation blocks that route migration on semantic mismatch, invariant failure, forbidden SQL shape, latency budget breach, response-size budget breach, or relevant browser/desktop verification failure.

## Current Baseline After Phase 4 Audit

- Phase 3 serving foundations still exist: read contracts, contract inventory, admission, cursor/filter signatures, SQL-shape guards, projector writer/services, snapshot pins, title-search projection, and the serving projector worker.
- Phase 4 service boundaries now exist: `reviewServingReader.ts`, `reviewBulkOperationService.ts`, `reviewBulkOperationWorker.ts`, `reviewSearchService.ts`, `reviewServingRouteParityRunner.ts`, LLM/human/both/unassessed route services, and filter route service.
- Most planned production review route inventory entries are now marked `mounted: true` in `reviewServingReadContractRouteInventory`. The only remaining `mounted: false` entry is the internal `/api/review-serving/filter-postings` helper inventory row.
- The current production route cutover is partial-complete, not final-complete. Mounted routes call serving readers or job services, but some route files still perform auxiliary app-table reads for metadata/detail/health/warning/prompt-preview semantics, and the route-specific parity runner exists as a generic blocker rather than a populated per-route parity suite.
- Legacy OLAP code remains in `src/services/olap/duckdbOlap.ts` and is still tested, but the audited mounted review route files are protected by inventory tests against direct `runDuckdbJsonQuery`, `duckdbOlap`, `selected_scoped_article_import`, and `OFFSET` use.
- The implemented state vocabulary remains `ready`, `indexing`, `stale`, and `unavailable` for freshness; `candidate`, `active`, `failed`, and `retired` are snapshot statuses that reader diagnostics expose without treating failed or candidate snapshots as readable freshness states.

## Phase 4 Audit Update - 2026-06-19

- Verdict: Phase 4 is substantially implemented but not ready to close. Serving readers, mounted route services, durable bulk jobs, bulk worker execution, adjacent route classification, static route guards, explicit search ownership, residual auxiliary read classification, and route/job parity coverage inventory now exist. Remaining closure work is populated per-route parity fixtures/sampled runs and browser/desktop verification.
- Implemented route evidence: `src/server/reviewServing/reviewServingReadContracts.ts` marks `/api/articlesreviews`, `/api/articlesreviewscount`, `/api/articlesreviewshuman`, `/api/articlesreviewsboth`, `/api/articlesreviewsunassessed`, `/api/articlesreviewsfilters`, `/api/articlesreviewshumanfilters`, `/api/projectsreview`, `/api/projectsreviewswarnings`, `/api/projectsreviewshealth`, prompt preview, PDF-by-filter/project/bulk, add-articles-by-filter, and export as `mounted: true`.
- Serving route evidence: `projectsRoutesGetArticlesReviews.ts`, `projectsRoutesGetArticlesReviewsCount.ts`, `projectsRoutesGetArticlesReviewsHuman.ts`, `projectsRoutesGetArticlesReviewsBoth.ts`, `projectsRoutesGetArticlesReviewsUnassessed.ts`, `projectsRoutesGetArticlesReviewsFilters.ts`, and `projectsRoutesGetArticlesReviewsHumanFilters.ts` import serving route services instead of OLAP wrappers.
- Durable job evidence: `ArticlesRoutes.ts`, `ProjectsAddArticlesRoutes.ts`, and `ProjectExportRoutes.ts` call `createReviewBulkOperationJob`; `reviewBulkOperationService.ts` persists to `app.review_bulk_operation_job`; `reviewBulkOperationWorker.ts` claims and executes those jobs in bounded batches; `/api/articles/pdf-fetch-jobs/:jobId` reads durable PDF job status through `getPdfFetchJobFromDatabase`.
- Guard evidence: `reviewServingReadContracts.test.ts` scans mounted route files and fails on `runDuckdbJsonQuery`, `selected_scoped_article_import`, OLAP wrapper imports, raw fallback text, and `OFFSET`; route service tests check serving SQL avoids `selected_scoped_article_import`, raw article/judgment tables, `OFFSET`, and JSON extraction.
- Parity evidence: `reviewServingRouteParityRunner.ts` and `reviewServingRouteParityRunner.test.ts` block semantic fixture, sampled parity, cursor, freshness, named count, SQL-shape, forbidden foreground DuckDB, latency, and response-size mismatches. `reviewServingRouteParityCoverage.ts` now inventories required route/job parity gates for every mounted production route and the explicit add-by-ID job flow. Populated semantic fixtures and sampled current-behavior runs for every route remain incomplete.
- Search evidence resolved: production list route services intentionally own ready token-prefix search through title-token helpers and `readReviewServingRows`; `reviewSearchService.ts` remains the internal owner for async substring job behavior. `reviewServingSearchOwnership.ts` and its tests codify this boundary.
- Adjacent route evidence: `reviewServingAdjacentRouteSurfaces.ts` classifies `/api/articles/search`, `/api/articles/latest`, `/api/projects/:id/articles`, judgment-job diagnostics, and HumanAssessment routes. Human assessment init is classified migrated-serving and submit migrated-admission; global article search/latest and project article membership reads are classified out of scope.
- Residual read evidence resolved: `reviewServingResidualReadAllowlist.ts` classifies remaining route-local app-table/app-query reads in filter, health, warnings, detail, and prompt-preview routes as bounded auxiliary metadata/config/diagnostic/detail reads around serving data. `reviewServingResidualReadAllowlist.test.ts` guards the current markers.
- Residual legacy evidence resolved: `src/server/services/pdfFetchJobs.ts` no longer contains the in-memory `jobs` map or legacy `startPdfFetchJob`/`getPdfFetchJob`; migrated PDF route lookup reads durable bulk job rows.
- Explicit-ID add evidence resolved: `/api/projects/add_articles_by_ids` in `ProjectsAddArticlesRoutes.ts` now creates a durable `review.bulk.selection` job with article-ID-only criteria and caps instead of calling `insertArticlesIntoProject` in the foreground request.

### Implementation Cycle 1 - 2026-06-19

- Re-read verdict: Phase 4 remained incomplete because legacy process-local PDF helpers still existed alongside durable PDF job routes.
- Implemented: removed the in-memory PDF job map plus `startPdfFetchJob` and `getPdfFetchJob` from `src/server/services/pdfFetchJobs.ts`. Kept `processPdfFetchArticleIds` for durable worker execution and `getPdfFetchJobFromDatabase` for `/api/articles/pdf-fetch-jobs/:jobId`.
- Added guard: `src/server/services/pdfFetchJobs.test.ts` fails if process-local PDF job state or legacy helper exports return.
- Verification: `/Users/fredrik/.bun/bin/bun test src/server/services/pdfFetchJobs.test.ts src/server/reviewServing/reviewBulkOperationService.test.ts`.
- Audit result: Phase 4 is still incomplete. Remaining gaps are route-specific parity coverage, residual auxiliary app read classification, search ownership/wiring, explicit-ID add-to-project treatment, and browser/desktop verification evidence.

### Implementation Cycle 2 - 2026-06-19

- Re-read verdict: Phase 4 remained incomplete because `/api/projects/add_articles_by_ids` still performed synchronous project insertion after only enforcing article-ID caps.
- Implemented: migrated `/api/projects/add_articles_by_ids` to `createReviewBulkOperationJob` with `jobKind: 'review.bulk.selection'`, `operation: 'addToProject'`, explicit `articleIds`, latest-snapshot semantics, no search, and a durable request ID. The worker already executes explicit article-ID batches through `insertArticlesIntoProject` outside the foreground request.
- Added guard: `src/server/routes/ProjectsAddArticlesRoutes.test.ts` proves add-by-ID creates a durable article-ID-only job and does not call `insertArticlesIntoProject` in the route.
- Verification: `/Users/fredrik/.bun/bin/bun test src/server/routes/ProjectsAddArticlesRoutes.test.ts src/server/workers/reviewBulkOperationWorker.test.ts`.
- Audit result: Phase 4 is still incomplete. Remaining gaps are route-specific parity coverage, residual auxiliary app read classification, search ownership/wiring, and browser/desktop verification evidence.

### Implementation Cycle 3 - 2026-06-19

- Re-read verdict: Phase 4 remained incomplete because search ownership was ambiguous: `reviewSearchService.ts` existed, while production list routes already used token-prefix serving readers directly.
- Implemented: added `reviewServingSearchOwnership.ts` to make the ownership decision explicit. Production list route services remain the ready token-prefix search boundary; `reviewSearchService.ts` remains internal for async substring search work.
- Added guard: `reviewServingSearchOwnership.test.ts` proves production route services use `getReviewServingTitleSearchTokens` plus `readReviewServingRows` and do not import `searchReviewServing`, while `reviewSearchService.ts` owns `review.search.substringAsync` job creation.
- Verification: `/Users/fredrik/.bun/bin/bun test src/server/reviewServing/reviewServingSearchOwnership.test.ts src/server/reviewServing/reviewSearchService.test.ts`.
- Audit result: Phase 4 is still incomplete. Remaining gaps are route-specific parity coverage, residual auxiliary app read classification, and browser/desktop verification evidence.

### Implementation Cycle 4 - 2026-06-19

- Re-read verdict: Phase 4 remained incomplete because filter, health, warnings, detail, and prompt-preview routes still had unclassified route-local app-table/app-query reads around serving data.
- Implemented: added `reviewServingResidualReadAllowlist.ts` to classify those reads as bounded project prompt/config metadata, review health/warning diagnostics, review detail metadata, and prompt-preview metadata/sample-article reads.
- Added guard: `reviewServingResidualReadAllowlist.test.ts` proves the audited mounted route files with residual app reads have classifications and that each classification marker still matches current route code.
- Verification: `/Users/fredrik/.bun/bin/bun test src/server/reviewServing/reviewServingResidualReadAllowlist.test.ts src/server/reviewServing/reviewServingReadContracts.test.ts`.
- Audit result: Phase 4 is still incomplete. Remaining gaps are route-specific parity coverage and browser/desktop verification evidence.

### Implementation Cycle 5 - 2026-06-19

- Re-read verdict: Phase 4 remained incomplete because the generic parity runner was not tied to a route/job coverage matrix for every mounted production surface.
- Implemented: added `reviewServingRouteParityCoverage.ts` with required route parity gates for mounted non-job routes and required job-flow gates for durable bulk/PDF/export/add-to-project flows, including explicit add-by-ID.
- Added guard: `reviewServingRouteParityCoverage.test.ts` proves every mounted non-job production route has route parity coverage requirements, every mounted job route plus explicit add-by-ID has job parity coverage requirements, and every coverage entry includes the required gates.
- Verification: `/Users/fredrik/.bun/bin/bun test src/server/reviewServing/reviewServingRouteParityCoverage.test.ts src/server/reviewServing/reviewServingRouteParityRunner.test.ts`.
- Audit result after 5 cycles: Phase 4 is still incomplete. Remaining gaps are populated route-specific semantic fixtures/sampled parity runs and browser/desktop review-flow verification evidence.

### Second-Pass Validation - 2026-06-19

- The first-pass Phase 4 verdict still matches current main: `reviewServingReadContractRouteInventory` has the same mounted production route shape, with only `/api/review-serving/filter-postings` left unmounted as an internal helper inventory row.
- The documented search-service gap is still accurate. `searchReviewServing` is only exercised by `reviewSearchService.test.ts`; production route handlers and route services use serving reader/filter/title-token paths directly.
- The residual-read gap needed one scope correction: mounted filter routes also depend on app-query project prompt/config metadata, so Phase 4 closure should classify those reads alongside health, warnings, detail, and prompt preview rather than treating filter routes as fully self-contained serving reads.
- The explicit-ID job note should remain nuanced: `/api/articles/pdf-fetch-bulk` already creates a durable article-ID-only job with `assertArticleIdOnlyBulkOperationCaps`, while `/api/projects/add_articles_by_ids` only enforces the cap and remains a synchronous `insertArticlesIntoProject` mutation.
- No code implementation change is required from this pass; the actionable Phase 4 update is to make residual-read classification and parity prerequisites more precise.

## Implementation Readiness Review - 2026-06-18

- Verdict: Phase 4 is ready to start as an implementation backlog, but no production route is ready to mount yet. The next safe slice is non-mounted reader/job/search/parity implementation plus tests behind the existing `mounted: false` inventory.
- No Phase 4 production route migration appears complete. `reviewServingReadContractRouteInventory` has no `mounted: true` entries, and the target route handlers still use OLAP wrappers, direct DuckDB SQL, shared raw hydration helpers, or process-local PDF job state.
- Do not re-implement the Phase 3 foundation listed below. Phase 4 should build on it and only change a production route after that route's serving reader, parity, SQL-shape, budget, and browser/desktop gates pass.
- Phase 3 is not fully complete as of this review. Before any route inventory entry becomes `mounted: true`, close or explicitly re-scope the remaining Phase 3 gaps recorded in `DUCK_CQRS_PLAN_PHASE_3.md`: component compaction beyond selected-import, remaining route-required projector coverage, and the Phase 3 Effect rule decision. Base selected-import projector wiring, production projector worker scheduling, chunk discovery, display/payload/search/status/queue/posting/summary/judgment-detail chunk execution, selected-import compaction during promotion, cleanup target discovery, internal diagnostics, prompt badge count coverage, and queue contribution count coverage now exist.

This section is retained as historical context. The 2026-06-19 audit supersedes its implementation status claims.

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

## Missing Before Phase 4 Closure

- Route-specific parity fixtures and sampled safe-size comparisons for every `mounted: true` production route and job flow. `reviewServingRouteParityCoverage.ts` now inventories required coverage, but populated fixture/sample executions remain incomplete.
- Completed: residual route-local app-table/app-query reads in filter, health, warnings, detail, and prompt-preview routes are explicitly classified and guarded as bounded auxiliary metadata/config/diagnostic/detail reads.
- Completed: list/filter route-service token-prefix wiring is the final production ready-search boundary; `reviewSearchService.ts` remains internal/job-only for async substring behavior.
- Completed: `/api/projects/add_articles_by_ids` now uses durable article-ID-only job admission with per-request ID and payload caps.
- Completed: legacy process-local PDF job helpers were deleted from `pdfFetchJobs.ts`; migrated PDF routes use durable jobs and DB-backed lookup.
- Browser review-flow verification for freshness diagnostics and desktop route-surface verification or desktop build for shared runtime changes.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [~] | Foreground serving reads | `reviewServingReader.ts` and route services are implemented and most production review inventory entries are `mounted: true`. Keep remaining closure work focused on parity, residual auxiliary reads, and browser/desktop verification. | Route-service and inventory tests prove no OLAP/raw fallback in mounted route files, but Phase 4 is not closed until per-route parity and residual read decisions pass. |
| [~] | Route-specific parity validation | `reviewServingRouteParityRunner.ts` is implemented and tested as a generic gate; `reviewServingRouteParityCoverage.ts` inventories every mounted route/job flow that must run parity. Populate route-specific cases before closing each mounted route/flow. | Parity checks pass for row payload semantics, named count states, freshness states, cursor behavior, SQL shape, latency budgets, result bytes, and no forbidden foreground DuckDB work for every mounted route. |
| [x] | Bulk, export, PDF, and search jobs | Durable bulk/PDF/export/add-by-filter/add-by-ID jobs exist on `app.review_bulk_operation_job`; production ready search is route-service token-prefix serving reads, and `reviewSearchService.ts` owns async substring job behavior. | Bulk route tests, worker tests, and search ownership tests cover persisted criteria, bounded batches, and the search boundary decision. |
| [x] | DuckDB usage migration | Mounted route files are guarded against direct OLAP/raw patterns, adjacent surfaces are classified, residual auxiliary app-query reads are allowlisted, legacy PDF helpers are deleted, and all known normal review-related DuckDB uses are accounted for. | Static route guards, adjacent-route classification, search ownership, and residual-read allowlist tests cover the migration boundary. |

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

### Current Route Implementation Check - 2026-06-19

- Implemented: LLM, count, human, both, unassessed, review filters, and human filters routes call serving route services from `src/server/reviewServing` instead of OLAP wrappers.
- Implemented: detail, warnings, health, prompt preview, human assessment init, PDF, add-by-filter, and export routes have mounted serving/job/admission entries or adjacent-route classifications.
- Implemented: `reviewServingReadContracts.test.ts` scans mounted route files for forbidden OLAP/raw patterns and `OFFSET`.
- Partially implemented: route-specific parity coverage requirements now exist for every mounted route or flow, but populated semantic fixtures and sampled current-behavior runs are not complete.
- Implemented: filter, health, warnings, detail, and prompt-preview routes have classified bounded auxiliary app-table/app-query reads guarded by `reviewServingResidualReadAllowlist.test.ts`.
- Implemented: `/api/projects/add_articles_by_ids` creates a durable article-ID-only job with capped explicit IDs.
- Implemented: legacy in-memory PDF helpers were deleted; migrated PDF route lookup reads durable `app.review_bulk_operation_job` rows through `getPdfFetchJobFromDatabase`.
- Clarified: `/api/articles/search`, `/api/articles/latest`, `/api/projects/:id/articles`, judgment-job diagnostics, and HumanAssessment routes are classified in `reviewServingAdjacentRouteSurfaces.ts`.

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
- Add-to-project by explicit IDs uses durable article-ID-only admission with per-request ID and payload caps.
- Add-to-project by filter uses a substring async selection contract when the product route receives substring search input; it must not certify substring behavior under token-prefix search semantics.
- PDF fetch uses durable bulk jobs with snapshot pins or declared latest-snapshot semantics.
- Project export uses serving/export jobs with projection-identity/snapshot/filter cursors, snapshot pins, and payload budgets.
- Ready title search uses token/prefix search projection.
- Unsupported substring search returns unavailable/search-indexing state or creates bounded async work over projected/searchable state.
- Synchronous substring scans over raw or large serving title state are not admitted at 10M scale unless a benchmarked n-gram projection is added.
- Explicit-ID PDF bulk requests use durable article-ID-only job admission with per-request ID and payload budgets. Filter/project PDF requests use persisted selection criteria and never materialize all matching IDs in the foreground request.
- Job routes and lookup routes, including `/api/articles/pdf-fetch-jobs/:jobId`, bind `job_kind`, filter signature, search mode/text when relevant, projection identity, snapshot pin or latest-snapshot semantics, `updated_at`, and `job_id`; they do not reuse article-row cursors for job-table pagination or in-memory process-local job state.

### Current Job Implementation Check - 2026-06-19

- Implemented: `reviewBulkOperationService.ts` writes durable `app.review_bulk_operation_job` rows with criteria, filter signature, snapshot semantics, cursor JSON, batch size, status, result manifest, progress, cancellation, retry, and last error fields.
- Implemented: `reviewBulkOperationWorker.ts` claims pending/stale jobs, uses bounded keyset batches, updates progress, supports cancellation/retry/resume, and avoids `OFFSET` in worker tests.
- Implemented: PDF-by-filter, PDF-by-project, PDF explicit-ID bulk, add-to-project-by-filter, add-to-project-by-ID, and export routes create durable jobs instead of returning all matching IDs from foreground requests.
- Implemented: `/api/articles/pdf-fetch-jobs/:jobId` reads durable PDF job state from `app.review_bulk_operation_job`.
- Implemented: `reviewSearchService.ts` persists substring async work in `app.review_search_job`; production ready-search ownership is intentionally kept in list/filter route services via token-prefix serving readers.
- Implemented: legacy in-memory PDF helpers were deleted from `pdfFetchJobs.ts`.

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
| Implemented | `src/server/reviewServing/reviewServingReader.ts` | Composes contracts, admission, manifests, cursor/filter signatures, SQL builder, diagnostics, and no raw fallback result path. |
| Implemented | `src/server/reviewServing/reviewBulkOperationService.ts` | Persists criteria and job identity in `app.review_bulk_operation_job`, verifies persisted jobs through read contracts, and enforces explicit article-ID caps. |
| Implemented | `src/server/workers/reviewBulkOperationWorker.ts` | Executes durable jobs in bounded keyset batches with cancellation, retry, resume, heartbeat, and progress state. |
| Implemented | `src/server/reviewServing/reviewSearchService.ts` | Implements token-prefix ready search and substring async/unavailable behavior; explicit ownership inventory classifies production ready search as route-service token-prefix serving reads and keeps this service internal/job-only for substring async work. |
| Partially implemented | Route-specific parity validation runner/checks | Generic runner, tests, and route/job coverage inventory exist. Per-route semantic fixtures and safe-size current-behavior cases remain incomplete. |
| Partially implemented | Route tests for serving-only behavior and durable job creation | Static mounted-route guard tests and route/job service tests exist. Complete per-route response parity and browser/desktop verification remain open. |
| Partially present | Static or route-surface tests for browser/desktop classification | Adjacent route classifications exist. Phase 4 still needs serving/job-specific browser and desktop verification for changed shared runtime paths. |

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
- [x] Targeted tests prove select-all, add-to-project by filter, PDF-by-filter/project, and export use durable jobs and keyset-batched execution without returning all matching article IDs; explicit-ID add-to-project and PDF bulk paths enforce article-ID-only caps.
- [ ] Targeted tests prove durable job lookups, including `/api/articles/pdf-fetch-jobs/:jobId`, bind job kind, filter signature, search mode/text when relevant, and pinned or latest-snapshot semantics using job-table cursor fields instead of in-memory process-local state.
- [ ] Targeted tests prove repeatable durable jobs pin serving snapshots and cleanup skips pinned base/patch/payload/count/search state.
- [ ] Targeted tests prove foreground query admission rejects or serves stale for over-budget workload classes before DuckDB execution.
- [ ] Targeted tests prove foreground admission rejects mismatched search modes before DuckDB execution.
- [ ] Targeted tests prove route-specific parity validation blocks route migration on semantic fixture, invariant, sampled parity, cursor, freshness-state, SQL-shape, latency, or response-size mismatches.
- [ ] Browser review-flow verification for stale, indexing, and unavailable freshness states plus failed, candidate, retired, and missing snapshot diagnostics.
- [ ] Desktop route-surface verification or targeted desktop build when shared runtime paths change.
- [ ] `bun run lint`
