# DuckDB Long-Term Serving Index Plan

## Problem

Import and materialization should be able to run at the same time. The observed OOM happens when foreground review reads issue maintenance-grade DuckDB queries while import and mart refresh already use the same constrained DuckDB runtime.

The failing query shape includes `selected_scoped_article_import`, which ranks scoped import rows with `ROW_NUMBER()` and JSON metadata sort keys. That is too expensive for interactive review-list requests during large imports.

The long-term requirement is larger than avoiding one OOM. Review, filter, badge, queue, and count reads must stay fast and predictable for projects with millions of articles and judgments on the shared browser/desktop DuckDB runtime.

## Strategy

Use an event-driven serving-index pipeline as the durable read architecture.

Raw `app.*` tables are the write/audit model. Import, judgment, human-review, and project-scope writes append compact deltas. Bounded projectors consume those deltas and maintain generationed, read-optimized serving state. Product review routes read only completed serving generations.

The important shift is to avoid selected scoped import resolution, raw judgment aggregation, raw count computation, JSON extraction, and project-wide windows in product reads. Import writes stay cheap, projectors do bounded work, and review routes have no code path that can perform project-wide windows, raw total counts, raw fallback, or large JSON sorts.

This is a CQRS-style split:

- Write model: `app.article`, `app.article_import_route`, `app.judgment`, human judgment tables, and append-only delta ledgers.
- Projection model: bounded projectors with leases, cursors, high-water marks, and completed-generation promotion.
- Read model: compact `mart.*_serving` tables keyed by project, generation, filter state, and cursor sort keys.

## Success Criteria

- [ ] Import, dirty materialization, and review-index refresh can overlap without review-list OOMs.
- [ ] Review lists remain readable during materialization by using the last completed serving generation.
- [ ] Foreground API reads never run unbounded raw/import-route scans.
- [ ] Foreground review routes never execute project-wide windows, raw total counts, or JSON sorts.
- [ ] Import writes append deltas cheaply and do not synchronously fan out selected-import state to every affected project.
- [ ] Selected scoped import state is maintained by bounded projectors with generation/checkpoint semantics.
- [ ] Review list, count, facet, badge, and unassessed-queue reads use serving indexes only.
- [ ] Hot serving rows contain typed columns for sort, filters, badges, and selected import fields.
- [ ] Counts and facets are precomputed or nullable; they are never computed from raw tables in request paths.
- [ ] Large JSON/detail payloads are kept out of hot list/filter serving rows.
- [ ] Product list routes use keyset pagination and never require `OFFSET` over large scopes.
- [ ] DuckDB settings are not silently retried, downgraded, or mutated after failures.
- [ ] OOM logs include enough state to identify route, project, workload class, active generation, and raw/serving mode.

## Target Read Shape

Foreground review-list routes should look like this:

```sql
SELECT ...
FROM mart.review_article_serving
WHERE project_id = ?
  AND generation = ?
  AND has_all_llm_judgments = FALSE
  AND (activity_sort_at, article_id) < (?, ?)
ORDER BY activity_sort_at DESC, article_id ASC
LIMIT ?
```

Counts and facets should look like this:

```sql
SELECT count_value
FROM mart.review_article_count_serving
WHERE project_id = ?
  AND generation = ?
  AND count_kind = ?
  AND filter_key = ?
```

No raw fallback. No `ROW_NUMBER()`. No JSON extraction. No raw total count. No `OFFSET` over large projects.

## Work Checklist

| Status | Priority | Task | Improves | Performance Suggestions |
|---|---|---|---|---|
| [ ] | P0 | Make review serving the hard product-read boundary. | Review list, filter, count, badge, row, and unassessed endpoints stop issuing raw `app.article`, `app.judgment`, and `app.article_import_route` scans during normal use. | If a serving generation exists, always serve it. If it is dirty, return stale data plus progress. If no generation exists, return indexing state and empty rows. |
| [ ] | P0 | Add an append-only import delta ledger. | Import stays cheap and projectors no longer rediscover changes from raw route tables. | Record `delta_id`, `import_run_id`, `import_route_id`, `article_id`, `change_kind`, `source_record_key`, `changed_at`, and compact rank/filter fields. Do not synchronously fan out `affected_project_id` unless route-to-project fanout is proven bounded. |
| [ ] | P0 | Add bounded project-route/import delta projectors. | Resolves route/article deltas into project/article work without making import writes do project fanout. | Project route deltas by `import_route_id` and cursor. Emit project/article dirty work in batches. Track high-water marks and leases per projector. |
| [ ] | P0 | Add a bounded selected-import projector. | Eliminates foreground `selected_scoped_article_import` and avoids import-write fanout. | Project deltas into selected import state in small batches. Use projector cursors/checkpoints and release work after max wake time or max batch count. |
| [ ] | P0 | Add generation/checkpoint semantics to selected import state. | Makes partial rebuilds, projector crashes, and cutovers unambiguous. | Track generation, source delta high-water mark, status, cursor, started/completed timestamps, and last error. Promote only completed generations. |
| [ ] | P0 | Denormalize selected import and badge fields into hot serving rows. | Preserves existing API response fields while keeping review reads single-table or keyed-lookup backed. | Copy selected external ID, selected import record ID, route ID, source record key, source URL, duplicate/conflict flags, study key, journal title, and precomputed sort keys from projections. |
| [ ] | P0 | Add precomputed count and facet serving tables. | Count, badge, unassessed count, and filter routes remain O(1) or bounded by small facet rows. | Maintain `mart.review_article_count_serving` and `mart.review_filter_facet_serving` by project/generation/filter key. Return `null` or stale counts when unavailable; never compute raw counts on request. |
| [ ] | P0 | Remove raw fallback from foreground review routes. | Prevents future OOMs caused by first-load or stale-state product reads. | Keep raw reads only behind admin/maintenance/debug routes. If a preview is required, preview from current import-run deltas or serving rows only, never by scanning raw route scope. |
| [ ] | P1 | Add hard foreground query admission. | Stops accidental maintenance-grade work from entering interactive routes. | Reject foreground queries that require full raw scans, raw total counts, project-wide windows, large JSON extraction/sorts, unbounded joins, or large-offset pagination. |
| [ ] | P1 | Add memory-aware projector and materialization backpressure. | Prevents background work from monopolizing the DuckDB owner during large imports or low-memory runs. | Bound by max wake time, max batch count, queue depth, active import state, and `DUCKDB_MEMORY_LIMIT`. Lower batch sizes when memory is `<=6400MiB`. |
| [ ] | P1 | Split hot serving rows from detail payload rows. | Keeps review-list reads small and avoids hydrating large JSON/raw payloads. | Put IDs, title, dates, flags, filter keys, sort keys, selected external ID, and status fields in `mart.review_article_serving`. Put optional JSON/detail payloads in `mart.review_article_serving_payload`. |
| [ ] | P1 | Add generation retention and cleanup. | Keeps storage bounded as serving indexes rebuild over time. | Keep active, staged, and last known-good generations. Clean older payload/detail/count/facet rows in bounded cleanup batches. |
| [ ] | P1 | Pre-extract JSON hot fields during import. | Reduces repeated JSON parsing in rank decisions, filters, badges, and URLs. | Persist duplicate/conflict flags, study key, source URL, source kind, rank bucket, and stable source-record fields as columns used by projectors. |
| [ ] | P2 | Add OOM and workload diagnostics. | Makes future OOMs actionable without reproducing locally. | Log route, project, workload class, memory limit, temp dir, queue metrics, dirty token, completed token, active import run, active serving generation, projector generation, and raw/serving mode. |

## Proposed Tables

| Table | Purpose | Performance Notes |
|---|---|---|
| `app.import_run_article_delta` | Append-only ledger of article/import-route changes from import runs. | Index by `import_route_id, delta_id`, `article_id, delta_id`, and `import_run_id`. Keep rows compact and avoid large JSON payloads. Do not require project fanout in import writes. |
| `app.project_import_delta_cursor` | Projector cursor from route/article import deltas to project/article dirty work. | Track project, route, source delta high-water, lease, status, cursor, and errors. Use this to resolve affected projects in bounded batches. |
| `app.project_selected_article_import_generation` | Projector generation/checkpoint state for selected import projection. | Track `project_id`, `generation`, `source_delta_high_water`, cursor fields, status, owner, lease, started/completed timestamps, and errors. |
| `app.project_selected_article_import` | Generationed selected scoped import per project/article. | Key by `project_id, generation, article_id`. Store selected IDs and rank/filter/display fields. Promote completed generations atomically. |
| `mart.review_article_serving` | Hot review-list/filter/count serving index. | Store only small fields needed for list UI, filters, sorting, badges, and selected external IDs. Query by `project_id, generation` with keyset pagination. |
| `mart.review_article_serving_payload` | Optional detail payloads for larger JSON/raw metadata. | Load by `project_id, generation, article_id` only on detail routes or explicit hydration steps. |
| `mart.review_article_count_serving` | Precomputed count and badge values. | Key by `project_id, generation, count_kind, filter_key`. Keep values small and nullable/stale-aware. |
| `mart.review_filter_facet_serving` | Precomputed filter/facet values. | Key by `project_id, generation, facet_kind, prompt_id, answer_id/value`. Serve filter UIs without grouping raw facts. |
| `mart.review_unassessed_queue_serving` | Optional unassessed queue candidate ordering. | Key by `project_id, generation, priority_bucket, activity_sort_at, article_id`. Use when queue routes need stable high-throughput candidate reads. |

## Delta Ledger Guidance

Import deltas should describe what changed, not every product view affected by the change. This keeps import writes cheap at million-scale.

- Prefer route/article deltas: `delta_id`, `import_run_id`, `import_route_id`, `article_id`, `change_kind`, source record key/hash, changed timestamp, and compact rank/filter fields.
- Resolve affected projects in bounded projector work by joining route deltas to `app.project_import_route`.
- Only persist `affected_project_id` in the import-write transaction if route-to-project fanout is measured and bounded.
- Keep large JSON, raw payloads, source records, and audit data out of the delta ledger.
- Make projector output idempotent by `(project_id, source_delta_high_water, article_id)` or generation-scoped keys.

## Performance Rules

- Product review routes read only from `mart.review_article_serving` and keyed payload/detail tables.
- Product review routes do not call raw fallback, even when serving is stale or missing.
- Initial index missing means return indexing state and empty rows, not a raw scan.
- Dirty index means return stale serving rows plus progress state.
- Use keyset pagination, not offset pagination, for hot review lists.
- Counts must be precomputed or nullable; do not calculate raw counts on hot paths.
- Filter/facet values must be precomputed or served from compact facet tables; do not `GROUP BY` raw judgments on hot paths.
- Do not run `ROW_NUMBER()` over project-wide import-route rows in request paths.
- Do not extract JSON inside `ORDER BY`, `GROUP BY`, or window functions on hot paths.
- Projectors consume deltas by cursor/high-water mark and bounded batch size.
- Background workers release claims after a wake budget so import, materialization, and serving refresh can interleave.
- Large JSON/raw payloads live in payload tables, not hot serving rows.
- Under low-memory runtimes, reduce projector/materialization batch sizes before increasing concurrency.
- Keep active, staging, and last known-good generations; clean obsolete generations in bounded batches.
- Store and compare generation state explicitly so foreground routes know whether data is active, stale, indexing, failed, or missing.
- Prefer clear cutovers that rebuild obsolete intermediate state over compatibility shims that keep old and new paths alive.

## Cutover Plan

1. Add import delta ledger, project import-delta cursors, selected-import generation state, generationed selected-import projection, count/facet serving tables, and optional serving payload table.
2. Add typed hot selected-import/filter columns to existing serving writers so the current `mart.review_article_serving` becomes the first hard serving target.
3. Backfill import deltas or seed projector high-water state from current import-route/source-record state with bounded batches.
4. Build route/project delta projector that turns import-route deltas into project/article dirty work without import-write fanout.
5. Build selected-import projector that consumes deltas and writes completed generations.
6. Update import writers to append compact deltas transactionally with import-route/source-record changes.
7. Update dirty marking to consume projector output and enqueue article-scoped dirty state whenever possible.
8. Update serving mart writers to copy hot selected import/filter/badge fields from completed projections.
9. Build precomputed count/facet serving projections and wire count/filter routes to them.
10. Update foreground review routes to read from serving indexes only, including stale completed generations while refresh is in progress.
11. Remove raw fallback from normal review-list/count/filter/unassessed paths and keep raw reads behind admin/maintenance/debug flows.
12. Add hard foreground query admission and OOM diagnostics.
13. Add generation retention cleanup for serving, payload, count, facet, and selected-import rows.
14. Rebuild or clear obsolete intermediate state after cutover.

## Non-Goals

- Do not fix this only by raising `DUCKDB_MEMORY_LIMIT`.
- Do not silently retry, downgrade, or mutate DuckDB/query settings after OOM.
- Do not preserve obsolete intermediate state with compatibility shims unless explicitly required.
- Do not open additional live DuckDB readers for the API while a maintenance owner is writing, unless reads are from a controlled snapshot or serving projection.
- Do not keep raw review fallback as a hidden normal path for large/importing projects.
- Do not synchronously fan out selected import state to every project inside import writes.
- Do not make `affected_project_id` mandatory in import deltas unless route-to-project fanout is proven bounded.
- Do not preserve unlimited serving generations.

## Quality Gates

- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] `bun test src/server/services/projectMartDirtyMaterializationService.test.ts`
- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] Targeted tests for import delta ledger writes
- [ ] Targeted tests for route/project delta projector fanout and cursor behavior
- [ ] Targeted tests for selected import projector generation/checkpoint behavior
- [ ] Targeted tests for count/facet serving projections
- [ ] Targeted tests proving foreground review routes do not include raw fallback, `selected_scoped_article_import`, or raw project-wide scans
- [ ] Targeted tests proving review list routes use keyset pagination and do not require large `OFFSET`
- [ ] `bun run lint`
- [ ] `bun run db:mig` if schema/projection migrations are added
- [ ] Add an `OOM_ERRORS.md` entry in the same change as any OOM fix implementation
