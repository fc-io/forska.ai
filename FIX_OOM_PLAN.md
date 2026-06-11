# Fix OOM Plan

## Goal

Eliminate the recurring DuckDB OOMs on the maintenance-worker writer without raising `DUCKDB_MEMORY_LIMIT` as the primary fix.

Covered failures:

- Comparison project serving rebuild OOMs for `comparisonProjectId=9fd6f6e9-5191-4d3e-a688-d1f86088d93c`.
- Judgment job unassessed count OOM on `GET /api/judgmentsjobs-unassessed-count?jobId=dc227fc7-9760-420e-ad36-65149a16c850`, where DuckDB fails inside a query beginning with `selected_scoped_article_import`.

## Current Findings

- Browser and desktop comparison routes are owner-dependent and proxy to the maintenance-worker DuckDB owner.
- API, judge-worker, comparison rebuilds, and judgment job maintenance share the same owner DuckDB runtime.
- With the observed `6.2 GiB` memory limit, `duckdbService` serializes main, background, and append DuckDB work onto one queue.
- The remaining comparison rebuild OOM risk is mostly single-query memory, not cross-writer overlap.
- The remaining unassessed-count OOM risk is the raw fallback count path building a large scoped import CTE, scoped article set, and grouped judgment count in one statement.

## Root Causes

1. Comparison cell builds are still unbounded.

`comparisonProjectServingCellBuilder` still inserts cells with full-scope `INSERT INTO mart.comparison_cell_serving ... SELECT ... FROM app.judgment/app.judgment_human/app.judgment_human_summary` statements. The previous rollup fix bounded article rollups and filter stats, but prompt/summary cell creation can still scan and aggregate too much at once.

2. Rebuild workflows can overlap at the application level.

The DuckDB queue serializes individual SQL statements, but `queueComparisonProjectServingRebuild` can start multiple fire-and-forget workflows for the same project. Two workflows can both stage `active_generation + 1`, and the later workflow can delete the earlier workflow's staged rows before promotion.

3. Unassessed count raw fallback is one large aggregate query.

`getUnassessedCountFromDuckdb` uses `countDuckdbUnassessedArticles` when project mart freshness is not fresh or serving rows are unavailable. That query constructs `selected_scoped_article_import`, `filtered_scope_article_ids`, then `LEFT JOIN app.judgment` and `GROUP BY` across the scope. For the failing URL, the count route does not need selected import payloads unless metadata filters are active.

## Recommended Fixes

| # | Fix | What It Does Now | What It Should Do | Why It Helps |
|---|---|---|---|---|
| 1 | Add a per-project comparison rebuild lease | Multiple rebuild workflows can interleave | Claim one rebuild per comparison project, heartbeat during phases, skip or coalesce duplicate queued rebuilds | Prevents duplicate staged generations and wasted memory-heavy work |
| 2 | Remove whole-phase transactions around bulk rebuild work | Bulk cell and rollup phases run inside transactions | Use small transactions only for status, generation allocation, promotion, and cleanup | Lets DuckDB release memory between batch statements |
| 3 | Batch comparison cell inserts by article id | Cell build scans full judgment/human tables per phase | Select article batches, then insert LLM/human cells only for that batch | Bounds the largest remaining comparison rebuild statement |
| 4 | Materialize comparison column/model config once per generation | Required column/model discovery repeats inside large statements | Store compact generation config or temp/staged config rows before batch inserts | Avoids repeated full-scope model discovery work |
| 5 | Keep bounded rollups and filter stats | Rollups are already batched | Preserve the existing bounded rollup and filter stats path | Avoids regressing the previous fix |
| 6 | Rewrite unassessed raw count fallback | Count does one full-scope grouped aggregate with scoped import ranking | Count over bounded article windows and batch judgment lookups; avoid scoped import ranking unless filters require it | Prevents `/api/judgmentsjobs-unassessed-count` from materializing huge intermediate state |
| 7 | Share bounded unassessed candidates with article preview | Raw unassessed articles can still enumerate full scope before slicing | Reuse the bounded unassessed candidate scan for `/api/judgmentsjobs-unassessed-articles` | Prevents the sibling endpoint from hitting the same OOM pattern |

## Implementation Plan

### 1. Comparison Rebuild Lease

- Add a per-comparison-project rebuild claim in `comparisonProjectServingRebuildService` or a sibling service.
- Use the existing `app.comparison_project_serving_generation` row as the simplest state holder if possible.
- Claim only when no fresh `refreshing` workflow exists for the same project, or when it is stale/expired.
- Update progress on each phase boundary.
- On duplicate route-triggered rebuilds, return/skip instead of starting another workflow.
- Preserve fire-and-forget route behavior, but make the rebuild service idempotent.

### 2. Comparison Cell Batching

- Add article batch discovery for comparison cell builds, similar to `getComparisonProjectArticleRollupBatch`.
- Batch prompt-mode LLM cells by joining to a small `article_batch` CTE.
- Batch prompt-mode human cells by the same `article_batch` CTE.
- Batch summary-mode LLM cells by the same `article_batch` CTE.
- Batch summary-mode human cells by the same `article_batch` CTE.
- Keep batches small enough for the 6400MiB maintenance-worker profile; start with 1000 or lower if summary-mode queries remain heavy.

### 3. Comparison Config Materialization

- Extract stable config from the current CTEs into compact generation-scoped state.
- Include prompt order, content variants, selected/discovered model order, source project summary config, and required column ids.
- Prefer temporary tables inside the rebuild if they are safe across the batched statements on one connection.
- If temporary tables are not safe with the current service shape, add small mart tables with a clear cutover migration and generation cleanup.
- Avoid backward-compatible parallel paths for obsolete intermediate state.

### 4. Comparison Transaction Boundaries

- Keep `stageComparisonProjectServingGeneration`, status updates, promotion, and cleanup transactional.
- Do not wrap full prompt cell, summary cell, or rollup phases in one transaction.
- Record progress before and after each phase.
- On failure, clean up only the claimed generation and do not mark a newer generation failed.

### 5. Unassessed Count Raw Fallback

- Add a bounded raw unassessed count path in `src/services/olap/duckdbOlap.ts`.
- Reuse `getDuckdbScopedActivityArticleCandidatesCteSql` or an equivalent mart-backed scope source so stale projects count dirty article candidates plus existing `mart.project_scope_article` rows.
- Iterate by activity/article cursor in article windows instead of one full-scope aggregate.
- For each article window, query judged prompt ids/counts with `article_id IN (...)`, the model/content settings, and project prompt ids.
- Accumulate `count += articleWindow.rows.filter(article is missing at least one prompt).length` in TypeScript.
- Do not build `selected_scoped_article_import` for unassessed count when `hasDuplicateStudyRecords` and `hasStudyDecisionConflict` are not requested.
- If metadata filters are requested, rank scoped imports only for the current article batch using `articleIds` or `articleIdFilterSql`.
- Keep the route response exact; do not silently return approximate counts.

### 6. Unassessed Articles Raw Fallback

- Replace `getUnassessedArticleRows` for the route preview path with the same bounded candidate window logic.
- Stop after collecting `offset + limit` unassessed rows instead of scanning all scoped articles.
- Hydrate only the returned article rows for display fields.
- Keep serving-path behavior unchanged when fresh serving rows exist.

### 7. Index Review

- Confirm existing indexes support the new windowed paths.
- Existing useful indexes include `idx_app_article_import_route_import_route_id` and `idx_app_project_article_article_id`.
- If batch scoped import ranking needs article-first lookup, add a DuckDB migration for `app.article_import_route(article_id, import_route_id)`.
- Do not add indexes speculatively if the batched query plans are already bounded and fast enough.

## Browser And Desktop Impact

- Browser API traffic already proxies owner-dependent comparison and judgment routes to the DuckDB owner.
- Desktop uses the same background maintenance-worker profile and Darwin default memory cap, so this plan directly targets the desktop OOM shape.
- Keep `bun run dev:server`, `bun run dev:app`, and desktop runtime ownership behavior unchanged.

## Tests

- Add comparison rebuild tests that two concurrent rebuild calls for one project do not both build/promote the same generation.
- Add comparison cell-builder SQL tests that generated inserts include `article_batch` filtering.
- Add comparison rebuild service tests that bulk phases are not wrapped in a single long transaction.
- Add unassessed count tests that raw fallback does not emit `selected_scoped_article_import` when metadata filters are absent.
- Add unassessed count tests that raw fallback scans multiple bounded windows and returns the exact count.
- Add unassessed articles tests that raw fallback stops after the requested page instead of scanning all scoped articles.

## Quality Gates

- `bun test src/server/services/comparisonProjectServingRebuildService.test.ts`
- `bun test src/server/services/comparisonProjectServingCellBuilder.test.ts`
- `bun test src/server/services/comparisonProjectServingRollupBuilder.test.ts`
- `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.test.ts`
- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- `bun test src/services/olap/duckdbOlap.test.ts`
- Targeted `bunx eslint` on changed files.
- `bun run db:mig` if a DuckDB migration is added.
- Browser verification: load comparison project route and judgment-job status/count views through `bun run dev:server` plus `bun run dev:app` when UI wiring is touched.
- Desktop verification: run `bun run desktop:build` when shared runtime path, owner proxy, or migration behavior changes.

## Rollout Notes

- Deploy the comparison rebuild lease before or together with cell batching to avoid duplicate rebuild pressure.
- Deploy unassessed count batching independently if the count endpoint remains the highest-priority incident.
- After deployment, retry the failing project rebuild and the failing unassessed count URL.
- Watch maintenance-worker DuckDB diagnostics for queue depth, temp spill, and memory-limit settings.
