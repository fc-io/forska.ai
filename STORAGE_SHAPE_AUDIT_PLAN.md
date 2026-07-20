# Storage Shape Audit Results

Generated from the review-storage audit strategy in
`REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md`.

## Status

This is the first durable audit artifact. It records repo-derived evidence from
the mounted API/read-contract inventory, DuckDB migrations, projector/reader
code, tests, and operator scripts. It does not inspect the live DuckDB file
directly.

The audit is actionable for the schema-shape questions that can be answered from
code and schema. Runtime row counts, physical bytes, null ratios, and oldest/newest
update timestamps are still marked as missing evidence until collected through
approved snapshot tooling.

## Evidence Used

- `src/server/reviewServing/reviewServingReadContracts.ts`
- `src/server/reviewServing/reviewServingRouteParityCoverage.ts`
- `src/server/reviewServing/reviewServingContracts.ts`
- `src/server/reviewServing/reviewServingReader.ts`
- `src/server/reviewServing/*Projector*.ts`
- `src/server/routes/projectsRoutes/*Review*.ts`
- `src/server/routes/ArticlesRoutes.ts`
- `src/server/routes/ProjectExportRoutes.ts`
- `src/db/duckdbMigrations/0097_reviewServingV4Foundation.sql`
- `src/db/duckdbMigrations/0098_reviewServingPayloadOrderColumns.sql`
- `src/db/duckdbMigrations/0099_reviewServingCountScopeAndDetailOptionTables.sql`
- `src/db/duckdbMigrations/0100_reviewServingFilterOptionValueKey.sql`
- `src/db/duckdbMigrations/0101_reviewServingFacetSummaryScope.sql`
- `src/db/duckdbMigrations/0102_reviewWriteOverlayReadSurface.sql`
- `src/db/duckdbMigrations/0103_reviewProjectionInputWatermarks.sql`
- `src/db/duckdbMigrations/0104_reviewServingArticleDisplayMetadata.sql`
- `src/db/duckdbMigrations/0105_reviewServingArticleMetadataStatus.sql`
- `src/db/duckdbMigrations/0106_reviewServingRemoveHotSourceMetadata.sql`
- `src/db/duckdbMigrations/0107_reviewServingRebuildRequest.sql`
- `src/db/duckdbMigrations/0108_reviewSelectedImportPatchDisplayFields.sql`
- `src/db/duckdbMigrations/0109_reviewServingJudgmentDetailPayloadKindForwardMigration.sql`
- `src/db/duckdbMigrations/0111_rebuildReviewRebuildRequestIndex.sql`
- `src/db/duckdbMigrations/0112_reviewServingSummaryRebuildPartial.sql`
- `src/db/duckdbMigrations/0113_reviewServingSummaryContributionRebuildPartial.sql`
- `src/db/duckdbMigrations/0114_dropReviewFilterPostingStatsLookupIndex.sql`
- `src/db/duckdbMigrations/0115_rebuildReviewServingProjectorWatermarkWithoutPrimaryKey.sql`
- `src/db/duckdbMigrations/0116_dropReviewServingProjectorWatermarkLookupIndex.sql`

## API Surface Inventory

Mounted review read surfaces:

- `POST /api/articlesreviews`: LLM review rows, count state, prompt badges,
  postings, list judgment hydration, token-prefix search, async substring
  search.
- `POST /api/articlesreviewscount`: LLM count with filters and search state.
- `POST /api/articlesreviewshuman`: human review rows/count, postings,
  judgment hydration, search.
- `POST /api/articlesreviewsboth`: both-mode rows/count, LLM and human judgment
  hydration, postings, search.
- `POST /api/articlesreviewsunassessed`: unassessed queue rows/count, postings,
  queue access, search.
- `GET /api/articlesreviewsfilters`: review filter options, facets, and search
  scope.
- `GET /api/articlesreviewshumanfilters`: human filter options, facets, and
  search scope.
- `POST /api/projectsreview`: detail row, detail payload, LLM judgments, human
  judgments, prompt badges.
- `POST /api/projectsreviewswarnings`: snapshot and indexing warning state.
- `POST /api/projectsreviewshealth`: health snapshot.
- `GET /api/projects/:id/prompts/:promptId/preview`: prompt preview plus detail
  payload.
- `POST /api/articles/pdf-fetch-by-filter`: bulk/PDF selection by filter.
- `POST /api/projects/add_articles_by_filter`: bulk add by filter.
- `POST /api/articles/pdf-fetch-by-project`: PDF selection by project.
- `POST /api/articles/pdf-fetch-bulk`: PDF selection by explicit IDs.
- `POST /api/projects/:id/export`: export selection and detail hydration.

Known unmounted/internal route surface:

- `POST /api/review-serving/filter-postings`: classified in read contracts but
  not mounted; use as contract documentation only.

Parity gates already named by the repo:

- Review routes: semantic fixture, sampled parity, cursor, freshness state,
  named count state, SQL shape, forbidden foreground DuckDB work, latency, and
  response size.
- Job routes: durable job persistence, keyset batching, article-ID caps, filter
  signature, snapshot semantics, and foreground payload cap.

## Current Read Shape

The serving design already has a useful split:

- Candidate/list rows: `mart.review_article_serving_v4`.
- Filter postings: `mart.review_article_filter_posting_serving_v4`.
- Posting cardinality/statistics: `mart.review_filter_posting_stats_v4`.
- Large article payload: `mart.review_article_serving_payload_v4`.
- Judgment detail payload: `mart.review_article_judgment_detail_serving_v4`.
- Exact counts/facets/options: `mart.review_article_count_serving_v4`,
  `mart.review_filter_facet_serving_v4`, and
  `mart.review_filter_option_serving_v4`.
- Queue rows: `mart.review_unassessed_queue_serving_v4`.
- Title token-prefix search: `mart.review_title_search_serving_v4`.
- Snapshot publication/control: `app.review_serving_snapshot_manifest`,
  `app.review_projection_identity_manifest`, pins, dirty work, rebuild requests,
  and chunk manifests.

The main shape problem is not that the whole design is wrong. The problem is
that several hot rows still carry values that are only needed after candidate
selection, and some control/partial tables need explicit disposition and
retention proof.

## Schema Census

### Source, Delta, And Intake Tables

- `app.import_run_article_delta`
  - Columns: delta identity, source table/row/operation, source partition/high
    water mark, import route, article, selected rank, publication year,
    tombstone, payload JSON, reconciliation timestamps.
  - Classification: read-write delta ledger.
  - Disposition: keep.
  - Reason: import-route changes feed selected-import and project-scope
    projection.
  - Missing evidence: retention horizon and physical row count.

- `app.review_change_delta`
  - Columns: delta identity, source metadata, project/article/prompt/model,
    content flags, judgment IDs, config field set, tombstone, payload JSON.
  - Classification: read-write delta ledger.
  - Disposition: keep.
  - Reason: judgment, human judgment, prompt/config, and article changes feed
    dirty work and rebuild invalidation.
  - Missing evidence: retention horizon and payload JSON size by change kind.

- `app.review_source_change_outbox`
  - Classification: recovery outbox.
  - Disposition: keep with bounded retention.
  - Reason: preserves source-change evidence for reconciliation and recovery.
  - Missing evidence: oldest unreconciled rows and retry/quarantine aging.

- `app.review_delta_reconciliation_cursor`
  - Classification: reconciliation cursor.
  - Disposition: keep.
  - Reason: prevents replay gaps/duplicates per source partition.

- `app.review_import_article_hot_field`
  - Columns include selected rank, publication year, title, journal, external
    ID, duplicate/conflict flags, and filter bucket fields.
  - Classification: reusable hot import fact.
  - Disposition: keep, but audit `article_title`, `journal_title`, and
    `external_id` as possible display duplication.
  - Reason: selected-import and posting projectors need rank/filter facts before
    list rows are built.

### Manifest, Snapshot, And Control Tables

- `app.review_serving_dirty_work`
  - Classification: control queue.
  - Disposition: keep with retention cleanup for completed/stale rows.
  - Reason: incremental projection input.

- `app.review_serving_dirty_work_ack`
  - Classification: acknowledgement ledger.
  - Disposition: keep with bounded retention.
  - Reason: guards component watermarks against double-processing.

- `app.review_project_import_delta_cursor`
  - Classification: unresolved/schema-only candidate.
  - Evidence: current code search found schema/test references but no obvious
    production reader/writer outside schema tests.
  - Disposition: investigate for deletion or merge into dirty intake cursor
    state.
  - Proof needed: confirm no import-delta intake path reads/writes it in
    production and no operator recovery depends on it.

- `app.review_serving_projector_watermark`
  - Classification: projector cursor/control state.
  - Disposition: keep.
  - Reason: stores component/source partition watermarks, leases, and cursor
    JSON; recent migrations intentionally removed fragile primary-key/index
    assumptions.

- `app.review_projection_identity_manifest`
  - Classification: component identity manifest.
  - Disposition: keep.
  - Reason: connects snapshot components to projection identities, generations,
    patch watermarks, input watermarks, and invalidation reasons.

- `app.review_rebuild_request`
  - Classification: rebuild admission/retry policy.
  - Disposition: keep.
  - Reason: foreground/requestless rebuild ownership, retry, OOM/budget
    diagnostics, and terminal state.

- `app.review_rebuild_chunk_manifest`
  - Classification: chunk execution manifest.
  - Disposition: keep, but compact completed old requests under retention.
  - Reason: chunk leases, OOM splitting, budget diagnostics, progress, and
    restart recovery depend on it.

- `app.review_selected_import_snapshot`
  - Classification: selected-import snapshot manifest.
  - Disposition: keep.
  - Reason: selected import membership/rank publication boundary.

- `app.review_selected_article_import_v4`
  - Classification: selected-import base table.
  - Disposition: keep, but audit display/rank duplicates column-by-column.
  - Reason: selected import is a reusable pre-limit fact for project scope,
    postings, display composition, and selected-route semantics.

- `app.review_serving_snapshot_manifest`
  - Classification: published snapshot manifest.
  - Disposition: keep.
  - Reason: active/last-known-good status, component identities, selected import
    snapshot, validation, and freshness/warnings all depend on it.

- `app.review_serving_snapshot_pin`
  - Classification: pin/retention guard.
  - Disposition: keep.
  - Reason: long-running export/PDF/bulk operations need stable snapshot
    semantics.

- `app.review_write_overlay`
  - Classification: foreground write overlay.
  - Disposition: keep if read-surface reconciliation remains required; otherwise
    shrink after proving stale-read windows are gone.
  - Reason: protects UX after fresh writes before projector convergence.

- `app.review_bulk_operation_job`
  - Classification: durable job control.
  - Disposition: keep.
  - Reason: bulk/PDF/export operations need persistent criteria, cursor, result
    manifest, and snapshot pin ownership.

- `app.review_search_job`
  - Classification: async search job control.
  - Disposition: keep.
  - Reason: substring search is intentionally not foreground project-scale scan.

- `app.review_serving_retention_mark`
  - Classification: retention progress marker.
  - Disposition: keep.
  - Reason: cleanup must be bounded and restartable.

### Serving And Projection Tables

- `mart.review_title_search_serving_v4`
  - Classification: token-prefix index.
  - Disposition: keep, with fan-out measurement.
  - Reason: search must avoid foreground title scans; recent performance work
    increased search chunk coalescing because per-token/chunk overhead was high.

- `mart.review_article_serving_v4`
  - Classification: hot candidate/list mart.
  - Disposition: slim.
  - Keep pre-limit fields: project/review/snapshot identity, list mode, article
    ID, sort/activity keys, selected import route/rank when used for list
    semantics, publication year/date fields used for filters/order,
    duplicate/conflict flags, LLM/human status keys, prompt counts, review-open
    state, and snapshot component identities needed by readers.
  - Move or late-hydrate candidates: `article_title`, `article_external_id`,
    `arxiv_id`, `biorxiv_id`, `medrxiv_id`, `doi`, `pmid`, `journal_title`,
    `url`, `full_text_pdf`, `full_text_fetched_at`,
    `full_text_conversion_status` unless a route proves pre-limit use.
  - Reason: the current table is used for candidate selection and list display,
    so display columns are repeated per `project x snapshot x list_mode x
    article`. Display-only values should be fetched after candidate IDs are
    bounded.

- `mart.review_article_display_patch_v4`
  - Classification: display patch/staging.
  - Disposition: keep until the slim-list change is implemented; then re-audit.
  - Reason: it is the component-owned display input for publication and
    incremental replacement.

- `mart.review_selected_import_patch_v4`
  - Classification: selected-import patch/staging.
  - Disposition: keep if incremental selected-import publishing remains; delete
    only if direct base/serving writes fully replace patch semantics.

- `mart.review_llm_status_patch_v4`
  - Classification: LLM status patch/staging.
  - Disposition: keep unless direct status publication removes it.
  - Reason: LLM prompt status drives filters, counts, list badges, and both-mode
    semantics.

- `mart.review_human_status_patch_v4`
  - Classification: human status patch/staging.
  - Disposition: keep unless direct status publication removes it.
  - Reason: human/both/unassessed routes and summary-mode human judgment
    semantics depend on these states.

- `mart.review_queue_patch_v4`
  - Classification: queue patch/staging.
  - Disposition: keep if incremental queue projection remains; otherwise merge
    into queue serving writes.

- `mart.review_article_filter_posting_patch_v4`
  - Classification: posting patch/staging.
  - Disposition: keep until posting rebuild/incremental ownership is simplified.

- `mart.review_article_filter_posting_serving_v4`
  - Classification: hot posting index.
  - Disposition: keep and benchmark selective filter kinds.
  - Reason: prompt answer, import route, publication year, duplicate/conflict,
    status, queue, and search-filter intersections need bounded set selection.

- `mart.review_filter_posting_stats_v4`
  - Classification: posting cardinality/statistics.
  - Disposition: keep table, keep index dropped.
  - Reason: table is still used by projector/diagnostics; migration 0114 removed
    the lookup index after it became more write cost than read benefit.

- `mart.review_article_serving_payload_v4`
  - Classification: keyed article payload.
  - Disposition: keep and expand as the home for display/detail fields that can
    be hydrated after candidate selection.
  - Reason: it already holds `source_metadata`, `abstract_text`,
    `full_text_preview`, and payload byte tracking by article/snapshot.

- `mart.review_article_judgment_detail_serving_v4`
  - Classification: keyed judgment payload/detail rows.
  - Disposition: keep, but split list-badge/minimal judgment fields from large
    detail payload if route evidence shows list pages read more than they render.
  - Reason: detail, prompt preview, list judgment hydration, filters, export, and
    PDF routes all read this table.

- `mart.review_article_summary_contribution_v4`
  - Classification: likely retired main summary contribution ledger.
  - Evidence: `TESTS.md` already names guard coverage for no writer, startup
    probe, projector, or retention dependency on the main summary contribution
    ledger; rebuild now uses request-scoped partial tables.
  - Disposition: delete candidate.
  - Proof needed: migration removes the table; schema/static guards pass; summary
    rebuild, retention, repair, and route parity tests pass.

- `mart.review_article_count_serving_v4`
  - Classification: exact named count serving table.
  - Disposition: keep.
  - Reason: foreground count routes and freshness states require exact named
    counts without project-scale scans.

- `mart.review_filter_facet_serving_v4`
  - Classification: facet summary serving table.
  - Disposition: keep, but verify every facet kind is consumed by the UI.
  - Reason: filter endpoints consume facets with summary identity and
    availability.

- `mart.review_filter_option_serving_v4`
  - Classification: filter option serving table.
  - Disposition: keep, but slim `option_payload_json` after comparing UI fields
    against returned payload.
  - Reason: route builds prompt filters and numeric bins from these rows; large
    unused payload JSON would be pure hot-row width.

- `mart.review_unassessed_queue_serving_v4`
  - Classification: queue serving table.
  - Disposition: keep.
  - Reason: unassessed route needs priority ordering without foreground judgment
    scans.

- `mart.review_article_summary_rebuild_partial_v4`
  - Classification: request-scoped summary rebuild partial.
  - Disposition: keep with strict retention.
  - Reason: enables bounded summary reduction; old partials should not persist
    beyond terminal request cleanup.

- `mart.review_article_summary_contribution_rebuild_partial_v4`
  - Classification: request-scoped contribution rebuild partial.
  - Disposition: keep with strict retention.
  - Reason: replaces the broad persistent contribution ledger during rebuild.

## Column Family Findings

- Display metadata is the highest-confidence slimming target.
  - Repeated in `app.review_import_article_hot_field`,
    `app.review_selected_article_import_v4`,
    `mart.review_article_display_patch_v4`,
    `mart.review_article_serving_v4`, and payload/detail surfaces.
  - Keep only fields needed for pre-limit filters/order in candidate marts.
  - Hydrate titles, journal/source IDs, external IDs, URLs, and full-text status
    after article IDs are bounded.

- Snapshot/component identity columns are intentionally repeated in hot serving
  tables.
  - Keep until readers can resolve identities once from a manifest and join by
    snapshot/component identity without extra per-row cost.
  - Do not remove before proving cursor and snapshot consistency.

- Posting rows are valid hot index rows, not display duplication.
  - Keep selective postings that serve mounted filters.
  - Remove only posting kinds with no route/UI consumer and no async job use.

- Count/facet/option rows are valid if they correspond to named route contracts.
  - Keep named exact counts.
  - Re-audit option payload JSON and facet kinds against UI consumption.

- Large text/JSON belongs in keyed payload/detail tables.
  - `source_metadata`, abstract, full-text preview, judgment payload JSON,
    explanations, and quotes should not be copied into candidate rows.

- Control tables are not deletion candidates just because no route reads them.
  - Snapshot, pin, dirty-work, chunk, watermark, request, cursor, and retention
    tables are writer/recovery surfaces.

## Deletion And Move Candidates

1. Delete `mart.review_article_summary_contribution_v4`.
   - Confidence: high.
   - Reason: request-scoped partials have replaced the main ledger and existing
     tests describe static guard coverage for no remaining runtime dependency.
   - Required proof: migration, schema test, summary projector tests, retention
     tests, integration route parity.

2. Investigate/delete `app.review_project_import_delta_cursor`.
   - Confidence: medium-low.
   - Reason: code search found schema/test references only.
   - Required proof: no production writer/reader, no repair/operator dependency,
     and import-delta dirty intake still has exact replay protection elsewhere.

3. Move display fields out of `mart.review_article_serving_v4`.
   - Confidence: high for fields that are display-only.
   - Required proof: reader can first select article IDs/order/counts from the
     slim mart, then hydrate display metadata by bounded article IDs with the
     same p95 and response contract.

4. Slim `mart.review_filter_option_serving_v4.option_payload_json`.
   - Confidence: medium.
   - Required proof: UI and route response only consume typed columns or a
     smaller payload shape for each filter kind.

5. Add retention cleanup for request-scoped partial tables.
   - Confidence: high.
   - Required proof: terminal rebuild requests can be cleaned while preserving
     active, failed evidence, pinned snapshots, and operator diagnostics.

## Proposed Target Shape

### Slim Candidate Mart

`mart.review_article_serving_v4` should become a narrow candidate/list-state mart
owned by snapshot/list-mode selection:

- identity: project, review config, snapshot, list mode, article
- ordering: sort/activity/article-created keys
- filter/status: publication year, duplicate/conflict, LLM/human status,
  prompt counts, review state, selected import route/rank
- snapshot consistency: component identities and generation/watermark metadata

Display fields should move to keyed hydration through either
`mart.review_article_serving_payload_v4` or a narrower display payload table.

### Payload Hydration

After a route has selected at most the configured page size of article IDs, it
should hydrate display/detail data by key:

- article title, external IDs, journal, URL, full-text status
- abstract/source metadata/full-text preview
- judgment detail payload, answers, placeholders, model metadata

The hydration query must preserve response order from the candidate query and
must remain capped by route page size or explicit bulk batch size.

### Summary And Filter Shapes

Keep exact named summary tables for foreground routes:

- `mart.review_article_count_serving_v4`
- `mart.review_filter_facet_serving_v4`
- `mart.review_filter_option_serving_v4`
- `mart.review_filter_posting_stats_v4`

Do not reintroduce project-scale foreground aggregation. Any dynamic combination
that cannot be answered from a bounded posting intersection should be async or
explicitly unavailable.

## Implementation Slices

1. Remove the retired main summary contribution ledger.
   - Add a migration dropping `mart.review_article_summary_contribution_v4`.
   - Keep request-scoped partial tables.
   - Run summary, retention, schema, projector writer, and phase integration
     tests.

2. Prove and either delete or justify `app.review_project_import_delta_cursor`.
   - Search dynamic SQL and operator scripts again.
   - Add a static guard if deleting.
   - Run dirty intake and selected-import rebuild tests.

3. Introduce bounded display hydration for review list routes.
   - Keep candidate selection in `mart.review_article_serving_v4`.
   - Hydrate display metadata for selected article IDs from payload/display
     storage.
   - Update read-contract/parity tests for identical route responses.

4. Physically slim `mart.review_article_serving_v4`.
   - Drop display-only columns only after slice 3 proves parity and benchmarks.
   - Keep date/status/filter/order fields that are pre-limit.

5. Slim filter option payload.
   - Compare filter endpoint response fields with UI consumption.
   - Replace large generic JSON with typed columns where possible.

6. Add retention for request-scoped rebuild partials.
   - Clean completed terminal request partials after evidence horizon.
   - Preserve failed-request diagnostics and active/pinned snapshot data.

7. Benchmark and route-parity gate the final shape.
   - Same fixture, same prompts/models/content settings.
   - Measure rows scanned, rows written, output bytes, temp spill, RSS, and
     p50/p95/p99 latency.

## Required Verification

For the next implementation PRs:

- `bun test src/server/reviewServing/reviewServingSchema.test.ts`
- `bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingProjectorWriter.test.ts src/server/reviewServing/reviewServingRetentionService.test.ts`
- `bun test src/server/reviewServing/reviewServingReader.test.ts src/server/reviewServing/reviewServingReadContracts.test.ts src/server/reviewServing/reviewServingRouteParityCoverage.test.ts`
- `bun test src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.test.ts src/server/reviewServing/reviewServingFilterRouteService.test.ts`
- `bun run lint`
- Same-fixture physical benchmark before and after any candidate-mart slimming.
- Browser review-tab verification for LLM, Human, Both, Unassessed, detail, and
  filters.
- Desktop restart/resume verification for storage/runtime changes.

## Missing Evidence To Collect

- Row counts and physical bytes for every current review-serving table.
- Null ratio and approximate distinct count for each candidate display/status
  column in `mart.review_article_serving_v4`.
- Oldest/newest `updated_at` or equivalent lifecycle timestamp for control,
  delta, partial, and retention tables.
- Per-route SQL timing before and after display hydration split.
- UI field-consumption proof for filter option payload JSON and facet groups.
- Active snapshot/pin counts and retained historical generation counts.

## Current Recommendation

Proceed in this order:

1. Delete the retired summary contribution ledger if the named proof passes.
2. Resolve the apparently schema-only import delta cursor.
3. Move display-only article metadata out of the hot list mart through bounded
   hydration.
4. Slim option payload JSON and add partial-table retention.

Do not start by deleting broad control tables or changing snapshot identity
columns. Those tables are part of correctness, replay, and recovery, even when no
mounted route reads them directly.
