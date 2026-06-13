# DuckDB CQRS Plan Phase 5 - Final Hardening And Release Gate

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Finish deleting any remaining normal raw fallback paths, harden browser/desktop behavior, and pass the final overlap benchmark and repo-native release gates before the normal review path is considered fully cut over.

## Cut Line

Final cutover completion happens only after Phases 0 through 4 are complete and every migrated route or flow has passed route-specific parity validation.

After final verification, normal product review paths must not reach raw fallback, `selected_scoped_article_import`, raw project-wide scans, unbounded ID materialization, or large-offset pagination.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [ ] | Final deletion sweep | Remove any remaining normal raw review fallback, old selected-import foreground joins, large-ID return paths, hidden `OFFSET` pagination, competing V4 serving writers, and obsolete intermediate state. | Static SQL-shape tests and route tests fail if forbidden raw paths return. Route-specific parity validation has passed for every migrated route/flow. Obsolete state is rebuilt or cleared with no compatibility shim unless explicitly required. |
| [ ] | Desktop and interruption hardening | Verify browser and desktop use the same serving/job/admission behavior. Test sleep/restart/interruption for projectors, bulk jobs, search jobs, and low-memory runtime. | Desktop build or targeted desktop verification passes, interrupted work resumes safely, and low-memory batch defaults prevent OOM. |
| [ ] | Final benchmark and release gate | Run the overlap benchmark and repo-native quality gates. | 10M/7-prompt benchmark passes under target memory limits, no foreground temp spill occurs for hot reads, all targeted tests pass, lint passes, and `OOM_ERRORS.md` is updated with the implementation entry. |

## Deletion Scope

- Confirm or delete any remaining normal raw review fallback.
- Confirm or delete any remaining foreground selected-import CTE joins from review, filter, count, bulk, and export paths.
- Confirm or delete any remaining large-ID return paths for select-all, add-to-project, PDF fetch, and export.
- Confirm or delete any remaining hidden `OFFSET` pagination from hot review paths.
- Confirm or retire any remaining competing V4 review-serving writers and promotion paths.
- Delete obsolete intermediate state after rebuild or clear cutover unless explicit compatibility is required.
- Keep admin/maintenance/debug-only raw reads only when named, route-classified, guarded, and excluded from normal product flows.

## Cutover Gate

- Phase 0 contracts, module boundaries, static guards, and benchmark harness are complete.
- Phase 1 schema and DuckDB workload-admission foundations are complete.
- Phase 2 write-side deltas, hot-field extraction, and read-your-write state are complete.
- Phase 3 projectors, selected-import projection, serving projections, manifests, and cleanup are complete.
- Phase 4 production route migration, jobs, search, route-specific parity, and DuckDB usage migration are complete.
- Route-specific parity validation has passed for semantic fixtures, sampled safe-size parity, named counts, freshness states, cursor behavior, SQL shape, latency, and response-size budgets for every migrated route/flow.
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
- Serving reads, cursors, counts, search, and jobs include the narrow projection identities they depend on and reject mismatched identity state.
- No normal browser or desktop review flow can reach raw fallback, `selected_scoped_article_import`, raw project-wide scans, unbounded ID materialization, or large-offset pagination.
- Admin/maintenance/debug-only raw reads are named, route-classified, guarded, and excluded from normal product flows.

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
- Repeated article/title changes, judgment changes, human-review changes, import appends, and prompt/config changes proving unrelated projections are not rerun.
- Physical read-shape evidence for hot routes: row groups/rows scanned, temp spill, response bytes, and ordered snapshot/filter prefix use.

## Quality Gates

- [ ] 10M-article/7-prompt benchmark fixture or synthetic equivalent is available and documented.
- [ ] Overlap benchmark passes under target DuckDB memory limits with import, dirty materialization, serving refresh, review list, filters, counts, bulk jobs, export/PDF jobs, and desktop-style interruption/resume.
- [ ] Benchmark records p50/p95/p99 latency, peak process memory, DuckDB memory limit, temp-dir growth, queue depth, admitted/rejected query counts, rows scanned, rows returned, and active snapshot/identity state.
- [ ] Benchmark proves foreground review reads are bounded by page size, selected filter postings, or precomputed summary rows, not total project article/judgment/import-route count.
- [ ] Benchmark proves routine deltas create bounded patches or dirty work, not full 10M-row serving copies, and compaction triggers before patch reads exceed hot-route budgets.
- [ ] Static SQL-shape tests fail if forbidden raw paths return.
- [ ] Route tests fail if normal product flows can reach raw fallback, `selected_scoped_article_import`, raw project-wide scans, unbounded ID materialization, or large-offset pagination.
- [ ] Desktop build or targeted desktop verification passes for shared runtime paths.
- [ ] Interrupted projector, bulk, search, and cleanup work resumes safely.
- [ ] `bun test src/server/reviewServing`
- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] `bun run db:mig` if schema/projection migrations are added
- [ ] `bun run lint`
- [ ] Add an `OOM_ERRORS.md` entry in the same change as any OOM fix implementation.
