# Better Performance For Compare Judgments Plan

## Context

The compare judgments page currently builds filtered judgment rows on every request. The server scans scoped articles in large batches, loads LLM and human rows, derives displayed answers, applies row and difference filters in TypeScript, counts all matching rows, then returns the requested page.

This is acceptable for small projects, but it does not scale to:

- Tens of thousands of human-vs-LLM rows.
- Millions of LLM-vs-LLM comparison rows.
- Any filter that requires derived cross-cell state before pagination.

The long-term fix is to treat compare judgments as a serving/indexing problem, not as a per-request derivation problem.

## Project Reviews Precedent

The scalable project reviews path already uses this model:

- Row data comes from generation-based serving marts.
- The LLM reviews page uses cursor/load-more pagination for the main data query.
- Exact counts are fetched separately and asynchronously.
- The table can render before exact totals are available.
- Counts are cached on the client for a longer window because they are more expensive than page reads.

Relevant current structures:

- `app.project_review_serving_generation`
- `mart.review_article_serving`
- `mart.review_article_serving_detail`
- `mart.review_article_filter_member`

Compare judgments should follow this scalable direction rather than the older exact-page `OFFSET` paths.

## Goals

- Make every compare judgments filter fast: `all`, `human-vs-llm`, `llm-vs-llm`, `any-disagreement`, `multiple-answers`, and `fully-answered`.
- Make page reads proportional to page size and visible columns, not total scoped rows.
- Avoid blocking first render on exact counts.
- Preserve browser and desktop flows.
- Keep export behavior consistent with the page filters.
- Keep the existing API shape only where it does not force slow behavior.

## Non-Goals

- Do not optimize only the current `human-vs-llm` summary-mode case.
- Do not add ad hoc SQL special cases for each filter as the final design.
- Do not rely on larger batch sizes or more indexes as the primary solution.
- Do not add backward-compatible mart shims unless a shipped consumer requires them.

## Recommended Architecture

Add a comparison-serving mart with active generation cutover.

Read path:

```text
active comparison generation -> filter/page row ids -> row metadata -> cells for visible rows -> optional count query
```

The judgments page should not derive row membership or count all matching rows in TypeScript on each request.

## Proposed Tables

### `app.comparison_project_serving_generation`

Tracks active and staged serving generations per comparison project.

Suggested columns:

- `comparison_project_id`
- `active_generation`
- `generation_updated_at`
- `refresh_status`
- `refresh_requested_at`
- `refresh_started_at`
- `refresh_finished_at`
- `refresh_error`

### `mart.comparison_article_serving`

One row per comparison project, generation, and article.

Suggested columns:

- `comparison_project_id`
- `generation`
- `article_id`
- `article_title`
- `article_summary`
- `article_created_at`
- `answered_column_count`
- `answered_prompt_count`
- `has_all_llm_columns`
- `has_all_human_columns`
- `has_multiple_answers`
- `has_human_vs_llm_difference`
- `has_llm_vs_llm_difference`
- `has_any_disagreement`
- `has_conflict`
- `row_sort_created_at`
- `row_sort_title`

### `mart.comparison_cell_serving`

One row per visible comparison cell.

Suggested columns:

- `comparison_project_id`
- `generation`
- `article_id`
- `column_id`
- `column_order`
- `kind`
- `prompt_id`
- `model_id`
- `source_project_id`
- `content_key`
- `display_answer`
- `normalized_answers`
- `source_created_at`
- `source_updated_at`

### `mart.comparison_filter_member`

One row per article and filter combination that the article matches.

Suggested columns:

- `comparison_project_id`
- `generation`
- `row_filter`
- `difference_filter`
- `article_id`
- `ordinal`
- `article_created_at`
- `article_title`

This table allows fast cursor and exact range reads for every finite filter combination.

### `mart.comparison_filter_stats`

One row per filter combination.

Suggested columns:

- `comparison_project_id`
- `generation`
- `row_filter`
- `difference_filter`
- `total_count`
- `stats_updated_at`

## API Changes

### Metadata Endpoint

Keep `/api/comparison-projects/:id` for metadata, columns, prompts, models, and available filters.

Add serving status fields so the page can show materialization progress:

- `servingStatus`
- `activeGeneration`
- `isServingReady`
- `servingUpdatedAt`

### Judgments Page Endpoint

Update `/api/comparison-projects/:id/judgments` to support cursor-first reads.

Suggested request fields:

- `limit`
- `cursor`
- `rowFilter`
- `differenceFilter`

Suggested response fields:

- `data`
- `limit`
- `nextCursor`
- `totalCount: null`
- `totalPages: null`
- `servingStatus`

The endpoint should:

- Resolve the active generation.
- Read matching article ids from `mart.comparison_filter_member` by cursor and limit.
- Join `mart.comparison_article_serving` for article metadata.
- Join `mart.comparison_cell_serving` only for returned article ids.
- Join conflict resolutions only for returned article ids.
- Return quickly without waiting for exact counts.

### Count Endpoint

Add `/api/comparison-projects/:id/judgments/count`.

Suggested response fields:

- `totalCount`
- `totalPages`
- `servingStatus`

This endpoint should read `mart.comparison_filter_stats`, not scan cells.

### Export Endpoint

Update export to stream from the serving mart.

The export should:

- Iterate `mart.comparison_filter_member` in ordinal batches.
- Join rows and cells per batch.
- Preserve the same filter semantics as the page.
- Avoid recomputing differences during export.

## UI Changes

- Change compare judgments pagination from exact page navigation to cursor/load-more, matching scalable project reviews behavior.
- Fetch row data first and count separately.
- Show a count skeleton while the count request resolves.
- Preserve filter state in the URL.
- Do not reset `differenceFilter` until metadata columns are loaded.
- Do not fetch judgments until metadata confirms the selected filter is valid.
- Keep browser and desktop behavior aligned because this route is shared app UI.

## Materialization Strategy

Build comparison serving in SQL, not TypeScript row loops.

Materialization steps:

1. Create a new inactive generation for the comparison project.
2. Build visible cell rows from LLM and human sources.
3. Build per-article rollups from cells.
4. Compute derived flags for all row and difference filters.
5. Insert filter membership rows for every matching `(rowFilter, differenceFilter)` pair.
6. Insert filter stats from filter membership counts.
7. Atomically promote the new generation.
8. Delete old generations after successful cutover.

## Filter Semantics

The serving builder must preserve existing semantics:

- `all`: every article with comparison data.
- `multiple-answers`: prompt mode means more than one answered prompt; summary mode means at least two answered shown columns.
- `fully-answered`: all shown LLM and human columns are answered.
- `human-vs-llm`: at least one prompt has both human and LLM answers and more than one normalized answer across those groups.
- `llm-vs-llm`: at least one prompt has more than one LLM answer and the normalized LLM answer set differs.
- `any-disagreement`: at least one prompt has more than one answered column and more than one normalized answer.

## Rebuild And Invalidation

Trigger or request a comparison-serving rebuild when:

- A comparison project is created.
- A comparison project is edited.
- LLM judgments change for a source project/model/content setting used by a comparison project.
- Human prompt judgments change for a prompt-mode human comparison.
- Human summary judgments change for a summary-mode human comparison.
- Conflict resolution does not require a full rebuild because it is joined at read time.

Prefer the same operational posture as project marts:

- Active generation remains readable during rebuild.
- Failed rebuilds preserve the last active generation.
- The UI exposes stale/refreshing/failed status.
- Large rebuild work is backgrounded.

## Rollout Plan

### Phase 1: Client Safety And API Preparation

- Fix the `differenceFilter` metadata race.
- Add cursor fields to the judgments endpoint response while keeping current page fields temporarily if needed.
- Add tests for preserving `differenceFilter=human-vs-llm` on initial load.

### Phase 2: Serving Schema

- Add DuckDB migrations for comparison serving generation, article serving, cell serving, filter member, and filter stats.
- Add indexes for active generation reads, filter membership reads, cell lookups, and stats lookups.

### Phase 3: Set-Based Builder

- Implement a comparison-serving materializer.
- Support prompt mode and summary mode.
- Validate output parity against current TypeScript filtering for representative fixtures.

### Phase 4: Fast Read Path

- Rewrite judgments endpoint to read from serving marts when available.
- Add separate count endpoint.
- Keep a small fallback only for missing active generation during rollout.

### Phase 5: UI Cursor Pagination

- Replace exact page controls with load-more controls.
- Fetch counts separately and asynchronously.
- Cache counts similarly to project reviews.

### Phase 6: Export From Serving

- Rework export to stream from filter membership and cell serving tables.
- Add export/page parity tests for every row and difference filter.

### Phase 7: Remove Slow Fallback

- Once serving rebuild is stable, remove the TypeScript full-scan fallback for normal reads.
- Keep a clear error/materializing state instead of silently doing unbounded request-time work.

## Risks

- Summary-mode LLM derivation must exactly match current `deriveStrictSummaryAnswer` behavior.
- Filter membership can grow if many filter combinations are materialized; keep combinations finite and explicit.
- Rebuild invalidation needs careful dependency mapping from projects, prompts, models, content settings, and source project links.
- Search-by-title and date filters may still require query-time filtering unless they are added to filter membership or handled with serving table predicates.
- Exact random-access page numbers are not the scalable default; cursor/load-more should be the primary UX.

## Recommended Decisions

- Use cursor/load-more for compare judgments, matching scalable project reviews.
- Fetch exact counts separately from `mart.comparison_filter_stats`.
- Do not support arbitrary page jumping for million-row filters unless there is a concrete user requirement.
- Do not make exact counts block the table request.
- Prefer serving-generation cutover over in-place mutation.

## Quality Gates

- `bun test src/utils/comparisonProjectDifferenceFilter.test.ts`
- `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- New serving builder tests covering prompt mode, summary mode, all row filters, all difference filters, and export/page parity.
- New route tests for cursor pagination, separate count endpoint, and stale/materializing status.
- `bun run lint`
- Browser verification: compare judgments page loads with `differenceFilter=human-vs-llm`, preserves the filter, loads rows before count, and supports load-more.
- Desktop verification for shared app route changes when UI/API wiring changes: `bun run desktop:build`.
