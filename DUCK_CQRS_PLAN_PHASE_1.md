# DuckDB CQRS Plan Phase 1 - Schema And Runtime Admission Foundation

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

## Objective

Add the empty durable schema and generic DuckDB workload-admission foundation required by later phases. This phase must not populate serving projections or switch product routes.

## Cut Line

Add empty durable schema, constraints, indexes, and generic DuckDB runtime admission hooks.

Phase 1 does not populate projections and does not switch product routes.

New serving schema must use `snapshot_id` for logical product snapshots and `base_generation`/`patch_watermark` for component physical state.

Existing V3 review mart tables that use `generation` remain legacy compatibility tables only for not-yet-migrated routes. Delete or hard-disable each dependent V3 normal path as its Phase 4 route migration lands, with any remainder cleared in Phase 5.

## Table Naming Rule

Create new review-serving mart tables with a `_v4` suffix when the unsuffixed name already exists or the old route still depends on the current schema.

Read contracts should point at the Phase 1 `_v4` physical tables.

After old callers are deleted, either keep the `_v4` names as permanent contract names or swap/rename during the Phase 5 final verification sweep.

Do not mutate legacy V3 table schemas during Phase 1.

## Workstreams

| Status | Theme | Implement First | Done When |
|---|---|---|---|
| [x] | Schema foundation | Add migrations for import deltas, review change deltas, review delta outbox/reconciliation cursors, import hot fields, coalesced dirty work, dirty-work acknowledgements, projector cursors/watermarks, projection identity manifests, rebuild chunk manifests, selected-import snapshots, logical snapshot manifests, snapshot pins, compacted serving bases, typed component patch tables, filter postings, posting stats, contribution rows, payloads, judgment-detail rows, filter-option rows, count/facet rows, search state, bulk jobs, write overlays, and retention metadata. Use `_v4` physical mart names where legacy V3 tables conflict. | `bun run db:mig` applies cleanly and schema tests prove the exact table names used by `reviewServingReadContracts.ts`, every non-job read contract's normalized physical `cursorFields` and `sort.fields`, common delta envelope fields, hot-field columns, outbox/reconciliation cursors, narrow identity keys, sorted/order keys, `snapshot_id`/`base_generation`/typed-patch fields, prompt-preview article ordering columns, required/optional component status, retention/pin fields, dirty-work acknowledgement fields, contribution keys, posting stats, and chunk resume fields exist. |
| [x] | Runtime admission foundation | Add generic workload classification and budget-enforcement hooks in the DuckDB runtime without adding product-specific SQL there. Extend the Phase 0 budget/read-contract shape with `timeoutMs`, and thread an optional workload context through DuckDB execution helpers and wrapper services with workload class, route/job key, project ID, result-row/byte budget, temp-spill policy, timeout, search mode, and stale/async fallback intent. | Registered review-serving foreground work can be admitted from contracts before DuckDB execution, unregistered migrated foreground work and mismatched search-mode work are rejected, registered stale-allowed work can serve stale or async according to its contract, legacy non-migrated routes remain explicitly classified during migration, and metrics include workload class, search mode, memory limit, temp usage, queue state, route/job key, and project context. |

## Review-Driven Schema Requirements

- `mart.review_article_serving_v4` must store the small row metadata needed by
  current list responses, including stable sort keys, article ID tie-breakers, and
  article timestamps or an explicit capped companion contract that provides them
  before list routes mount.
- `mart.review_article_count_serving_v4` includes `list_mode_key` so generic count
  keys such as `review.list.total` cannot collide across LLM, human, both, and
  unassessed modes.
- `mart.review_filter_facet_serving_v4` includes summary/filter scope,
  `facet_kind`, facet key/value, prompt/answer fields, and summary definition
  version in its lookup/key so review facets, human facets, search-scoped facets,
  and old summary versions cannot mix.
- `mart.review_filter_option_serving_v4` includes an option value discriminator
  and enough option/min-max payload columns to serve filter routes without falling
  back to raw grouping.
- `mart.review_article_judgment_detail_serving_v4` includes `list_mode_key` and a
  payload source discriminator such as `payload_kind` so LLM and human both-list
  payloads cannot overwrite or masquerade as each other.
- Job tables support both pinned snapshots and explicitly declared latest-snapshot
  semantics. Job lookups use `updated_at`/`job_id` sort fields and job-specific
  identity columns, not article-row fields.
- Snapshot manifests persist `snapshot_status` and enough active/retired/failed
  state for health and warning reads to choose usable snapshots and preserve the
  last-known-good snapshot.

## Required Schema Groups

- Delta ledgers: `app.import_run_article_delta`, `app.review_change_delta`
- Reconciliation: `app.review_source_change_outbox`, `app.review_delta_reconciliation_cursor`
- Import hot fields: `app.review_import_article_hot_field`
- Dirty work: `app.review_serving_dirty_work`, `app.review_serving_dirty_work_ack`, `app.review_project_import_delta_cursor`
- Projector state: `app.review_serving_projector_watermark`, `app.review_projection_identity_manifest`, `app.review_rebuild_chunk_manifest`
- Selected import: `app.review_selected_import_snapshot`, `app.review_selected_article_import_v4`
- Snapshot state: `app.review_serving_snapshot_manifest`, `app.review_serving_snapshot_pin`
- Reviewer overlay: `app.review_write_overlay`
- Jobs: `app.review_bulk_operation_job`, `app.review_search_job`
- Retention: `app.review_serving_retention_mark`
- Serving marts: `mart.review_article_serving_v4`, `mart.review_article_count_serving_v4`, `mart.review_filter_facet_serving_v4`, `mart.review_filter_option_serving_v4`, `mart.review_article_judgment_detail_serving_v4`, `mart.review_unassessed_queue_serving_v4`, `mart.review_title_search_serving_v4`
- Patch and support marts: `mart.review_article_display_patch_v4`, `mart.review_selected_import_patch_v4`, `mart.review_llm_status_patch_v4`, `mart.review_human_status_patch_v4`, `mart.review_queue_patch_v4`, `mart.review_article_filter_posting_patch_v4`, `mart.review_article_filter_posting_serving_v4`, `mart.review_filter_posting_stats_v4`, `mart.review_article_serving_payload_v4`, and `mart.review_article_summary_contribution_v4`

## Runtime Admission Requirements

- Low-level DuckDB helpers accept an optional workload context but contain no product-specific SQL or review-serving decisions.
- The workload context includes workload class, route/job key, project ID, row budget, byte budget, temp-spill policy, `timeoutMs`, `searchMode`, and fallback intent.
- Thread workload context through `duckdbService.ts`, `appDatabaseService.ts`, `readOnlyDuckdbService.ts`, `appReadOnlyDatabaseService.ts`, and `src/services/olap/duckdbRunner.ts` so route and worker wrappers cannot bypass contextual metrics or budget enforcement.
- Metrics include workload class, search mode, memory limit, temp usage, queue state, route/job key, project context, rows returned, result bytes, and failures.
- Budget enforcement happens when a workload context is supplied.
- Unregistered migrated foreground work is rejected. Only registered contracts whose freshness behavior allows stale or async fallback can serve stale or async instead of executing fresh DuckDB work.
- Requested search mode must match the registered contract search mode; omitted search mode means no search.
- Legacy non-migrated routes remain explicitly classified during migration instead of being silently treated as registered serving reads.

## Runtime Decisions

- `searchMode` is a contract and metrics dimension, not product SQL in the DuckDB runtime. It distinguishes no-search reads, token-prefix index reads, and async substring jobs so admission rejects mismatches and diagnostics show whether fast index paths or async job paths were used.
- Read-only DuckDB remains a direct read path for long-term read performance. Contextual read-only work is wrapped in the generic measured workload helper with `readOnlyQuery` metrics and budget checks, but it is not forced through the writer/owner queue.
- Migrated-route enforcement is route-inventory driven. A route becomes blocking only when its real product route inventory entry is mounted for Phase 4; until then legacy routes stay explicitly classified and cannot be counted as registered serving reads.
- Schema tests normalize contract cursor/sort fields by extracting physical leading identifiers and ignoring computed SQL expressions such as deterministic list-mode priority. Job contracts are checked separately and must stay on `updated_at`/`job_id` fields.

## Rules

- Use the `effect` library for non-trivial JavaScript/TypeScript async and server flow. Prefer `Effect.gen` for sequencing, `Layer`/`Context` for service wiring, `Effect.acquireRelease`/`Scope` for resource lifetime, and `Schedule` for retries, polling, and backoff. Keep pure transforms and very small handlers as plain functions.
- Do not populate projections in Phase 1.
- Do not promote serving snapshots in Phase 1.
- Do not switch product routes in Phase 1.
- Do not add product-specific SQL or contract knowledge to `duckdbService.ts`.
- Keep raw JSON out of hot import-field and hot serving schemas.
- Keep large payloads out of hot list/count/filter serving rows.
- Keep list/detail payload discriminators, filter option value keys, facet scope,
  and count list modes in schema keys so route-completeness tests cannot pass on
  rows that would collide or mix modes.

## Quality Gates

- [x] `bun run db:mig`
- [x] Live DuckDB owner did not block `bun run db:mig`.
- [x] `bun test src/server/reviewServing`
- [x] `bun test src/server/utils/duckdbService*.test.ts`
- [x] `bunx eslint src/server/reviewServing src/server/utils/duckdbService.ts`
- [x] `bun run lint`
- [x] Schema tests prove every table referenced by `reviewServingReadContracts.ts` exists.
- [x] Schema tests derive required physical columns from `reviewServingReadContracts.ts` and prove every non-job contract's normalized physical `cursorFields` and `sort.fields` exist on its final migrated serving table.
- [x] Schema tests prove job contracts use job-table `updated_at`/`job_id` fields and do not require article-row sort/cursor columns.
- [x] Schema tests prove prompt-preview payload ordering preserves current route semantics: `article_created_at ASC NULLS LAST, article_id ASC`, without inserting project ordinal before article ID.
- [x] Schema tests prove detail judgment and filter-option serving tables exist before those mounted routes can migrate.
- [x] Schema tests prove count rows include `list_mode_key`, facet rows include summary/filter scope, filter-option rows include option value keys, judgment detail rows include payload kind, and manifest reads use `snapshot_status`.
- [x] Schema tests prove list row response metadata, including article timestamps, is present on hot rows or covered by an explicit capped companion contract before list routes can be mounted.
- [x] Schema tests prove common delta envelope fields exist on both delta ledgers.
- [x] Schema tests prove `snapshot_id`, `base_generation`, `patch_watermark`, typed patch keys, required/optional component status, retention/pin fields, dirty-work ack fields, contribution keys, posting stats, and chunk resume fields exist.
- [x] Admission tests prove `timeoutMs` and `searchMode` are declared on read contracts, mapped into `DuckdbWorkloadContext`, recorded in metrics, and enforced when contextual work exceeds declared budgets.
- [x] Admission tests prove mismatched search modes are rejected before DuckDB execution.
- [x] Wrapper tests prove workload context can be passed through `appDatabaseService.ts`, `readOnlyDuckdbService.ts`, `appReadOnlyDatabaseService.ts`, and `src/services/olap/duckdbRunner.ts`.
- [x] Runtime tests prove over-budget contextual DuckDB work records metrics and is rejected before becoming a normal product success path.
- [x] Browser and desktop review flows are not changed by this phase.
