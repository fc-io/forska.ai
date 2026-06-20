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

## JavaScript And TypeScript Rule

Use the `effect` library for non-trivial JavaScript/TypeScript async and server flow in Phase 5 hardening, interruption handling, cleanup, benchmark orchestration, and release-gate checks. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for service wiring, `Effect.acquireRelease`/`Scope` for resource lifetime, and `Schedule` for retries, polling, and backoff. Keep pure transforms and very small handlers as plain functions.

## Final Benchmark Scope

- 10M articles in one project with an average of 7 prompts per article.
- Overlap import, dirty materialization, serving refresh, review list, filters, counts, token/prefix search, unavailable/async substring state, bulk jobs, PDF/export jobs, and desktop-style interruption/resume.
- Direct rows, posting/search selection, article-set row hydration, list/detail judgment payload hydration, human-specific facets/options, queue-kind reads, count reads across LLM/human/both/unassessed modes, bulk substring selection, token-prefix search, async substring jobs, bulk jobs, PDF/export jobs, and desktop-style interruption/resume.
- Repeated article/title changes, judgment changes, human-review changes, import appends, and prompt/config changes proving unrelated projections are not rerun.
- Physical read-shape evidence for hot routes: row groups/rows scanned, temp spill, response bytes, and ordered snapshot/filter prefix use.
- Work-item shape evidence: expected list mode, queue kind, count key/filter prefix, search mode/text, job kind/filter signature, and request-slice diversity are all validated before a release run can pass.

## Quality Gates

- [ ] 10M-article/7-prompt benchmark fixture or synthetic equivalent is available and documented.
- [ ] Overlap benchmark passes under target DuckDB memory limits with import, dirty materialization, serving refresh, review list, filters, counts, bulk jobs, export/PDF jobs, and desktop-style interruption/resume.
- [ ] Benchmark records p50/p95/p99 latency, peak process memory, DuckDB memory limit, temp-dir growth, queue depth, admitted/rejected query counts, rows scanned, rows returned, and active snapshot/identity state.
- [ ] Benchmark proves foreground review reads are bounded by page size, selected filter postings, or precomputed summary rows, not total project article/judgment/import-route count.
- [ ] Benchmark includes article-set hydration operations for LLM, human, both, and unassessed filtered rows.
- [ ] Benchmark includes list/detail judgment payload operations with prompt-overlap row targets for LLM, human, both LLM, and both human payloads.
- [ ] Benchmark includes human-specific facet and filter-option operations, named count operations for all list modes, queue-kind operations, token-prefix search, async substring search, bulk substring selection, and bulk/export/PDF job lookups.
- [ ] Benchmark validation rejects missing or unexpected dimensions, insufficient request-slice diversity, wrong count keys/filter prefixes, missing queue kind/list mode/search mode, over-wide rows scanned, foreground temp spill, latency target breaches, and RSS target breaches.
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
