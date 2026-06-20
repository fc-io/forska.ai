# DuckDB CQRS Plan Phase 5 - Final Hardening And Release Gate

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Finish deleting any remaining normal raw fallback paths, harden browser/desktop behavior, and pass the final overlap benchmark and repo-native release gates before the normal review path is considered fully cut over.

## Cut Line

Final cutover completion happens only after Phases 0 through 4 are complete and every migrated route or flow has passed route-specific parity validation.

After final verification, normal product review paths must not reach raw fallback, `selected_scoped_article_import`, raw project-wide scans, unbounded ID materialization, or large-offset pagination.

## Phase 5 Readiness Review - 2026-06-20

- Verdict: Phase 5 is ready to start. The 2026-06-20 final Phase 4 audit found the route/job/search/parity/residual-read/browser/desktop implementation evidence sufficient to proceed, with no remaining Phase 4 blocker.
- Superseded blockers: the 2026-06-19 notes below are retained as historical context, but their listed Phase 4 dependencies are now resolved by `reviewServingRouteParityCoverage.ts`, `reviewServingRouteParityEvidence.ts`, `reviewServingResidualReadAllowlist.ts`, `reviewServingSearchOwnership.ts`, durable add-by-ID/PDF/export job routes, deletion of process-local PDF helpers, browser warning tests, and recorded desktop build evidence.
- Phase 5 scope starts here: final deletion/static hardening, interruption and desktop runtime hardening, release-scale benchmark execution/evidence, and repo-native release gates. Do not reopen Phase 4 route migration unless Phase 5 hardening finds a concrete regression.

## Phase 5 Readiness Review - 2026-06-19

- Verdict: Phase 5 is not ready to start as a final hardening/release sweep. Phase 4 has advanced substantially, but closure gates remain open and Phase 5 must not treat mounted route inventory entries as equivalent to final semantic parity.
- Stale assumption: Phase 5 previously assumed Phase 4 would arrive as a complete route/job/search/parity migration. Current code has mounted serving/job routes and durable workers, but route-specific parity fixtures and sampled current-behavior checks are not complete for every mounted route or flow.
- Stale assumption: `reviewSearchService.ts` exists and supports token-prefix ready reads plus substring async/unavailable jobs, but production route calls to `searchReviewServing` were not found. Before Phase 5 benchmarks include search-service behavior, Phase 4 must either wire it into API/search flows or document that route services directly own token-prefix search and substring async state.
- Dependency on Phase 4 gap: `projectsRoutesGetArticlesReviewsFilters.ts` and `projectsRoutesGetArticlesReviewsHumanFilters.ts` call serving filter route services but still use app-query project prompt/config metadata; `projectsRoutesGetReviewsHealth.ts`, `projectsRoutesGetReviewsWarnings.ts`, `projectsRoutesPostArticleReviewDetails.ts`, and `projectsRoutesGetPromptPreview.ts` use serving reader contracts but still perform direct app-table or app-query reads for auxiliary metadata, project config, prompt/model/full-text, assessment, warning, or health details. Phase 5 deletion/static guards need an allowlist or new serving contracts for these reads before failing all direct app-table/app-query access in mounted routes.
- Dependency on Phase 4 gap: `/api/projects/add_articles_by_ids` remains a capped synchronous explicit-ID mutation through `insertArticlesIntoProject`. Phase 5 should not require durable job semantics for this route unless Phase 4 reclassifies or migrates it.
- Dependency on Phase 4 gap: `pdfFetchJobs.ts` still contains legacy in-memory job helpers while migrated PDF routes use durable `app.review_bulk_operation_job` lookup. Phase 5 should delete those helpers if unused, or explicitly classify any remaining caller as legacy/admin/debug-only.
- Missing prerequisite: browser review-flow verification for stale/indexing/unavailable/failed/candidate/retired/missing snapshot diagnostics and desktop route-surface verification or targeted desktop build for shared runtime behavior.
- Current benchmark support: `reviewServingBenchmark.ts` and `reviewServingBenchmark.test.ts` define a `synthetic10m7PromptOverlap` release workload with 28 operations and a smoke fixture, but that harness evidence does not replace Phase 4 route parity, residual-read decisions, browser/desktop verification, or an actual release benchmark run.
- Recommended adjustment: split Phase 5 into a short prerequisite audit gate before any deletion sweep or final benchmark sign-off. That gate should require updated Phase 4 parity status, residual-read allowlist, search-service decision, explicit-ID add decision, legacy PDF helper decision, benchmark-fixture/run readiness, and browser/desktop verification evidence.

### Second-Pass Validation - 2026-06-19

- The Phase 5 not-ready verdict still holds on current main. The blockers are planning/verification blockers, not missing Phase 5 implementation work to do in this docs PR.
- The prerequisite audit should distinguish static route guard readiness from semantic readiness: current mounted-route guard tests block obvious OLAP/raw patterns, but they do not prove full response parity for every mounted route or flow.
- The deletion sweep should not blanket-ban all app-table/app-query reads in mounted routes until Phase 4 classifies filter prompt/config reads and the auxiliary reads in health, warnings, detail, and prompt preview.
- The final benchmark workstream can start from the existing synthetic overlap workload definitions, but Phase 5 should still require evidence from the release-scale run under target memory limits before cutover.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [x] | Phase 4 closure prerequisite audit | Before deletion or benchmark sign-off, confirm route-specific parity coverage, residual app-table/app-query read decisions, search-service ownership, explicit-ID add behavior, legacy PDF helper status, benchmark-fixture/run readiness, and browser/desktop verification evidence. | The 2026-06-20 final Phase 4 audit confirmed route/job parity evidence, residual-read classification, search ownership, durable explicit-ID add, deleted legacy PDF helpers, browser diagnostics tests, and desktop build evidence. |
| [ ] | Final deletion sweep | Remove any remaining normal raw review fallback, old selected-import foreground joins, large-ID return paths, hidden `OFFSET` pagination, competing V4 serving writers, and obsolete intermediate state. Start only after the prerequisite audit decides which residual app-table/app-query reads are allowed metadata/config reads versus raw fallback. | Static SQL-shape tests and route tests fail if forbidden raw paths return. Route-specific parity validation has passed for every migrated route/flow, and every mounted route inventory entry covers the full product response shape. Obsolete state is rebuilt or cleared with no compatibility shim unless explicitly required. |
| [ ] | Desktop and interruption hardening | Verify browser and desktop use the same serving/job/admission behavior. Test sleep/restart/interruption for projectors, bulk jobs, search jobs, and low-memory runtime. | Desktop build or targeted desktop verification passes, interrupted work resumes safely, and low-memory batch defaults prevent OOM. |
| [ ] | Final benchmark and release gate | Run the overlap benchmark and repo-native quality gates after Phase 4 parity and residual-read decisions are closed. | 10M/7-prompt benchmark passes under target memory limits, no foreground temp spill occurs for hot reads, article-set hydration and judgment payload paths are exercised, all targeted tests pass, lint passes, and `OOM_ERRORS.md` is updated with the implementation entry. |

## Deletion Scope

- Confirm or delete any remaining normal raw review fallback.
- Confirm or delete any remaining foreground selected-import CTE joins from review, filter, count, bulk, and export paths.
- Confirm or delete any remaining large-ID return paths for select-all, add-to-project, PDF fetch, and export.
- Confirm or delete any remaining hidden `OFFSET` pagination from hot review paths.
- Confirm or retire any remaining competing V4 review-serving writers and promotion paths.
- Delete obsolete intermediate state after rebuild or clear cutover unless explicit compatibility is required.
- Keep admin/maintenance/debug-only raw reads only when named, route-classified, guarded, and excluded from normal product flows.

### Part 1 Final Deletion/Static Hardening Status - 2026-06-20

- Status: completed for the Part 1 static deletion sweep. No normal mounted review-route raw fallback, selected-import CTE join, hidden `OFFSET`, or route-local cursor/filter-signature path was found beyond the existing guard coverage in `reviewServingReadContracts.test.ts` and route-service SQL-shape tests.
- Raw/admin/debug classification hardening: judgment unassessed diagnostics and human-assessment overview routes were moved out of `supported-local-api` route-surface classification and into local diagnostics classification, matching their `reviewServingAdjacentRouteSurfaces.ts` out-of-scope admin/debug evidence.
- Large-ID return paths: add-by-filter, PDF-by-filter/project, and export remain durable job admissions; add-by-ID and explicit PDF bulk remain article-ID-only job admissions with `reviewBulkOperationArticleIdCap` and payload caps. No foreground all-ID response path was found in the inspected normal select-all/add-to-project/PDF/export routes.
- Export raw hydration: completed export download still hydrates bounded job-result article IDs in `exportBatchSize` chunks and is guarded as a sensitive local export route, not a foreground selection fallback. The export admission path queues durable jobs and does not return matching article IDs.
- V4 writer/promotion paths: the active writer/promotion path remains the review-serving projector/writer stack; no competing mounted product-route V4 promotion path was found in this Part 1 sweep.
- Obsolete intermediate state: no clearly safe state deletion was identified in Part 1. V4 base, patch, job, manifest, pin, and retention state remain active serving infrastructure and should not be deleted in this sweep.

Part 1 checklist:

- [x] Normal raw review fallback confirmed guarded or absent from mounted normal review routes.
- [x] Foreground selected-import CTE joins confirmed absent from normal review/filter/count/bulk selection routes; bounded export-download hydration remains classified separately.
- [x] Large-ID return paths confirmed replaced by durable job admission or explicit capped article-ID-only admission.
- [x] Hidden `OFFSET` pagination confirmed guarded in hot mounted review routes.
- [x] Competing V4 writer/promotion route paths not found; projector/writer stack remains the serving owner.
- [x] Admin/debug adjacent raw-read surfaces route-classified as diagnostics and tested against product classification drift.

## Cutover Gate

Prerequisite before evaluating this gate: the 2026-06-20 final Phase 4 audit in `DUCK_CQRS_PLAN_PHASE_4.md` is closed. Phase 5 may now evaluate the gate through deletion/static hardening, interruption and desktop verification, release-scale benchmark evidence, and repo-native release checks.

- Phase 0 contracts, module boundaries, static guards, and benchmark harness are complete.
- Phase 1 schema and DuckDB workload-admission foundations are complete.
- Phase 2 write-side deltas, hot-field extraction, and read-your-write state are complete.
- Phase 3 projectors, selected-import projection, serving projections, manifests, and cleanup are complete.
- Phase 4 production route migration, jobs, search, route-specific parity, and DuckDB usage migration are complete.
- Route-specific parity validation has passed for semantic fixtures, sampled safe-size parity, named counts, freshness states, cursor behavior, SQL shape, latency, and response-size budgets for every migrated route/flow.
- Every mounted route inventory entry represents complete product-route coverage, not partial helper coverage.
- Standalone count, filter-option, detail, warning, and prompt-preview routes preserve current product semantics or return explicit unavailable/async states for unsupported pieces.
- A single normal V4 serving writer owns all `mart.review_*_v4` writes and active V4 snapshot promotion.
- Legacy mart refresh/rebuild paths cannot promote competing V4 review snapshots.
- Serving manifests classify required versus optional components, and optional search/count work cannot block unrelated review-list activation.
- Logical snapshot/base/patch behavior is benchmarked, and routine deltas cannot full-copy project-scale serving rows.
- Layered projection identities prove model/prompt/content changes do not rebuild article/import/title/payload/search projections when those inputs are unchanged.
- Prompt-level identities prove one prompt change does not rebuild unchanged prompt projections or summaries.
- Component-narrow patches prove judgment-only changes do not rewrite display/import/payload/search fields.
- The invalidation registry covers every delta kind and forbids unmapped broad rebuild behavior.
- Incremental contribution diffs update counts, facets, badges, queues, and posting stats for routine changes without full reaggregation.
- Component-level dirty acknowledgements prove current required projectors skip work already processed even when optional projectors lag.
- Dirty-work acknowledgement state is compacted and cannot grow as one permanent row per dirty key/component.
- Rebuild chunk manifests prove interrupted or repeated rebuilds skip unchanged completed chunks.
- Rebuild chunk input digests are maintained incrementally by normal projection work, not computed by rescanning source rows during rebuild startup.
- Snapshot pins prevent cleanup from deleting data needed by repeatable durable jobs.
- Every synchronous filter route has a bounded ordered-prefix, posting-table, projection, or pre-proven candidate-set access path.
- Filter-option routes are backed by complete option/min-max response projections, not only article posting rows.
- Filtered list routes prove posting/search selection plus article-set row and list-payload hydration, including stable list-mode and article-ID tie-break ordering.
- List/detail payload routes preserve LLM judgment arrays, human prompt/summary payloads, both-mode payloads, prompt badges, current row metadata, article timestamps, and detail extras before they are mounted.
- Serving reads, cursors, counts, search, and jobs include the narrow projection identities they depend on and reject mismatched identity state.
- Foreground admission rejects mismatched search modes before DuckDB execution, and omitted search mode means no search.
- Durable job contracts bind job kind, filter signature, search mode/text when relevant, and pinned or latest-snapshot semantics through job-table fields.
- Search-service ownership is resolved: either production routes call `searchReviewServing` for the planned API boundary, or Phase 5 benchmark/search gates are rewritten around the route services that directly call `readReviewServingRows` with token-prefix and substring-async state.
- Residual app-table/app-query reads in mounted filter, health, warning, detail, and prompt-preview routes are either eliminated, covered by serving contracts, or explicitly allowed as bounded metadata/config reads with route parity evidence.
- Explicit-ID add-to-project behavior is either migrated to durable article-ID-only job admission or kept as a capped synchronous mutation with an explicit out-of-serving classification.
- Legacy process-local PDF job helpers are deleted or classified outside migrated PDF flows.
- No normal browser or desktop review flow can reach raw fallback, `selected_scoped_article_import`, raw project-wide scans, unbounded ID materialization, or large-offset pagination.
- Admin/maintenance/debug-only raw reads are named, route-classified, guarded, and excluded from normal product flows.

### Phase 3 Gap Carry-Forward - 2026-06-18

Phase 5 does not absorb unfinished Phase 3 projector work. Base selected-import projection, production projector worker scheduling, chunk discovery/resume checks, display/payload/search/status/queue/posting/summary/judgment-detail chunk execution, selected-import compaction during promotion, pin-aware retention cleanup, cleanup target discovery, internal diagnostics, prompt badge count coverage, queue contribution count coverage, and single-writer ownership now exist. If component compaction beyond selected-import or remaining route-required projector coverage remain incomplete or explicitly scoped out, the Phase 5 cutover gate must reflect that scope even if route-reader work exists. Phase 5 should verify these guarantees, not be the first phase to implement them.

## Desktop And Interruption Rules

- Browser and desktop flows use the same bounded serving/job/admission behavior.
- Desktop support is additive and must not break the browser flow.
- Projectors, bulk jobs, search jobs, and cleanup resume safely after sleep, restart, interruption, or ownership changes.
- Low-memory runtime defaults reduce batch sizes before increasing concurrency.
- Snapshot pins and retention cleanup must tolerate laptop storage and interruption patterns.

### Part 2 Desktop And Interruption Hardening Status - 2026-06-20

- Status: completed for targeted Part 2 hardening. Desktop now defaults its backend DuckDB runtime to the existing low-memory worker profile (`DUCKDB_MEMORY_LIMIT=6400MiB`) when no explicit override is provided, while preserving user/operator overrides.
- Browser/desktop parity evidence: `reviewServingDesktopInterruptionEvidence.ts` pins that the desktop shell starts the same `src/server/index.ts` backend, bridges `/api/` requests into the same API route surface, and relies on the shared serving read contracts, admission, and `readReviewServingRows` DuckDB workload contexts used by browser routes.
- Interruption/resume evidence: the evidence registry and tests cover projector dirty-work release, stale lease reclamation, chunk-manifest restart skipping, bulk/export/PDF stale-running job claims and keyset cursor progress, durable substring search jobs in `app.review_search_job`, and retention cleanup marks/pin protection.
- Low-memory evidence: desktop defaults to `6400MiB`; `duckdbService.ts` maps memory limits at or below `6400MiB` to one DuckDB thread plus serialized concurrent work; projector, bulk, search, and cleanup flows retain bounded batch/cursor defaults instead of raising concurrency.
- Targeted desktop verification: `src/desktop/getDesktopRuntimeConfig.test.ts` asserts the desktop backend command, API origin bridge preload, low-memory default, and explicit memory-limit override behavior. `bun run desktop:build` was run as the desktop build gate for this part.
- Remaining risks: full OS sleep/resume and process-kill simulation against a large local desktop database was not run in Part 2. The deterministic guard covers the durable resume contracts and will fail on source/test drift, but release-scale interruption remains part of the final benchmark/release gate.

Part 2 checklist:

- [x] Browser and desktop share serving/job/admission route behavior through the same backend and `/api/` route surface.
- [x] Projector resume contracts are covered by leases, dirty-work release, and chunk-manifest restart evidence.
- [x] Bulk/export/PDF resume contracts are covered by durable job rows, stale-running claims, keyset cursors, cancellation, and terminal failure evidence.
- [x] Search resume contracts are covered by durable async substring job rows and token-prefix ready reads.
- [x] Cleanup resume contracts are covered by bounded retention marks, target discovery, active pins, and last-known-good protection.
- [x] Desktop low-memory defaults select reduced DuckDB concurrency and bounded job/projector/search/cleanup batches before any concurrency increase.
- [x] Targeted desktop tests and desktop build evidence captured.

## JavaScript And TypeScript Rule

Use the `effect` library for non-trivial JavaScript/TypeScript async and server flow in Phase 5 hardening, interruption handling, cleanup, benchmark orchestration, and release-gate checks. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for service wiring, `Effect.acquireRelease`/`Scope` for resource lifetime, and `Schedule` for retries, polling, and backoff. Keep pure transforms and very small handlers as plain functions.

## Final Benchmark Scope

- 10M articles in one project with an average of 7 prompts per article.
- Overlap import, dirty materialization, serving refresh, review list, filters, counts, token/prefix search, unavailable/async substring state, bulk jobs, PDF/export jobs, and desktop-style interruption/resume.
- Direct rows, posting/search selection, article-set row hydration, list/detail judgment payload hydration, human-specific facets/options, queue-kind reads, count reads across LLM/human/both/unassessed modes, bulk substring selection, token-prefix search, async substring jobs, bulk jobs, PDF/export jobs, and desktop-style interruption/resume.
- Repeated article/title changes, judgment changes, human-review changes, import appends, and prompt/config changes proving unrelated projections are not rerun.
- Physical read-shape evidence for hot routes: row groups/rows scanned, temp spill, response bytes, and ordered snapshot/filter prefix use.
- Work-item shape evidence: expected list mode, queue kind, count key/filter prefix, search mode/text, job kind/filter signature, and request-slice diversity are all validated before a release run can pass.

### Part 3 Final Benchmark And Release Gate Status - 2026-06-20

- Status: completed as repo-native synthetic/release-report validation. A true local 10M DuckDB benchmark run was not executed in this environment; the harness now makes that explicit instead of treating smoke output as release-scale evidence.
- Fixture and scope: `reviewServingBenchmark.ts` documents the `synthetic10m7PromptOverlap` fixture at 10,000,000 articles, 7 prompts, and 70,000,000 article-prompt overlap rows. The release workload now includes 31 operations and explicit scope tags for import, dirty materialization, serving refresh, review list, filters, counts, token-prefix search, async substring state, bulk jobs, bulk substring selection, export/PDF jobs, article-set hydration, list/detail payloads, human facets/options, queue reads, and desktop-style interruption/resume.
- Deterministic release-gate validation: the benchmark runner and tests fail on missing canonical fixture/workload dimensions, insufficient request-slice diversity, wrong count key/filter prefix, wrong job/search shape, over-page returned rows, over-wide rows scanned, accepted temp spill, p95/p99 latency breach, RSS breach, missing active snapshot/identity fields, missing DuckDB memory limit, or negative temp-dir growth.
- Release report shape: smoke and future real runs emit a release report containing p50/p95/p99, peak RSS, DuckDB memory limit, temp-dir growth, queue depth, admitted/rejected counts, rows scanned/returned, and active project/snapshot/review-config/manifest/count/search identity state. Real release-scale runs must set `benchmarkRunKind: "releaseScaleDuckDb"`; smoke output remains `syntheticValidation`.
- Repo-native gate: `bun run bench:review-serving-release-gate` runs the focused benchmark tests and smoke benchmark report emission. `src/server/reviewServing/reviewServingBenchmark.md` documents both the smoke command and the release-gate validation command.
- Remaining risks: no physical 10M run, DuckDB row-group scan profile, RSS profile, or temp-dir growth profile was collected on this machine. The deterministic gate blocks incomplete or malformed release reports, but final cutover still needs an actual release-scale DuckDB run under the target memory limit and temp-dir location.

Part 3 checklist:

- [x] 10M/7-prompt synthetic equivalent is available and documented.
- [x] Repo-native validation covers the full requested benchmark scope and release-report fields.
- [x] Release validation rejects missing dimensions, request-slice diversity gaps, bad count/search/job dimensions, over-wide scans, temp spill, latency/RSS breaches, and malformed memory/temp/snapshot identity evidence.
- [x] Repo-native release-gate command is wired for focused benchmark validation and smoke report emission.
- [ ] True 10M DuckDB run under target memory limits with physical scan/temp/RSS evidence remains to be executed before final cutover.

## Quality Gates

- [x] 10M-article/7-prompt benchmark fixture or synthetic equivalent is available and documented.
- [ ] Overlap benchmark passes under target DuckDB memory limits with import, dirty materialization, serving refresh, review list, filters, counts, bulk jobs, export/PDF jobs, and desktop-style interruption/resume.
- [x] Benchmark records p50/p95/p99 latency, peak process memory, DuckDB memory limit, temp-dir growth, queue depth, admitted/rejected query counts, rows scanned, rows returned, and active snapshot/identity state.
- [x] Benchmark proves foreground review reads are bounded by page size, selected filter postings, or precomputed summary rows, not total project article/judgment/import-route count.
- [x] Benchmark includes article-set hydration operations for LLM, human, both, and unassessed filtered rows.
- [x] Benchmark includes list/detail judgment payload operations with prompt-overlap row targets for LLM, human, both LLM, and both human payloads.
- [x] Benchmark includes human-specific facet and filter-option operations, named count operations for all list modes, queue-kind operations, token-prefix search, async substring search, bulk substring selection, and bulk/export/PDF job lookups.
- [x] Benchmark validation rejects missing or unexpected dimensions, insufficient request-slice diversity, wrong count keys/filter prefixes, missing queue kind/list mode/search mode, over-wide rows scanned, foreground temp spill, latency target breaches, and RSS target breaches.
- [ ] Benchmark proves routine deltas create bounded patches or dirty work, not full 10M-row serving copies, and compaction triggers before patch reads exceed hot-route budgets.
- [ ] Static SQL-shape tests fail if forbidden raw paths return.
- [ ] Route tests fail if normal product flows can reach raw fallback, `selected_scoped_article_import`, raw project-wide scans, unbounded ID materialization, or large-offset pagination.
- [ ] Route inventory tests fail if `mounted: true` entries claim partial count, filter-option, detail, warning, or helper coverage as migrated product routes.
- [ ] Route tests prove count, filter-option, detail, warning, and prompt-preview migrated routes preserve full current semantics or expose explicit unavailable/async state.
- [ ] Admission tests prove mismatched search modes are rejected before DuckDB execution.
- [ ] Desktop build or targeted desktop verification passes for shared runtime paths.
- [ ] Interrupted projector, bulk, search, and cleanup work resumes safely.
- [ ] `bun test src/server/reviewServing`
- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] `bun run db:mig` if schema/projection migrations are added
- [ ] `bun run lint`
- [ ] Add an `OOM_ERRORS.md` entry in the same change as any OOM fix implementation.
