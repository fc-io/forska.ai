# OOM Errors

Record every out-of-memory issue and fix here.

Entry format:

## YYYY-MM-DD - Area

- Error: Short log excerpt.
- Context: Affected job, query, route, command, or runtime path.
- Cause: Short explanation of why memory was exhausted.
- Fix: Short explanation of the code, query, config, or operational change.
- Verification: Command, test, or runtime check used to verify the fix.

## 2026-06-13 - Articles Reviews Serving Read

- Error: `Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` from `POST /api/articlesreviews`.
- Context: Articles reviews request for project `e43a0bbb-703e-4701-a223-7488c5b40cd0`, with DuckDB query beginning `WITH selected_scoped_article_import AS`.
- Cause: Foreground review reads ranked selected import rows across the whole project while serving rows or returned article IDs were already enough to bound the work.
- Fix: Serving review reads no longer join selected imports for counts, list page selected-import ranking is scoped to `page_rows`, judgment hydration ranks selected imports only for returned article IDs, and raw no-metadata-filter review reads skip selected-import ranking.
- Verification: `bun test src/services/olap/duckdbOlap.test.ts`; `bun run lint`.

## 2026-06-12 - Comparison Serving Rollups

- Error: `Out of Memory Error: failed to allocate data of size 1.0 MiB (6.2 GiB/6.2 GiB used)` from `INSERT INTO mart.comparison_article_serving`.
- Context: Comparison serving rebuild `rollups` phase after staging `81,525` comparison cells and before inserting article rows.
- Cause: The article rollup insert still processed large 1,000-article batches and used several `COUNT(DISTINCT ...)` aggregates over staged cells in one DuckDB statement.
- Fix: Reduced article rollup batches to 100 articles and rewrote the article-serving rollup aggregates to use ordinary counts, sums, and min/max/boolean checks instead of distinct-count hash aggregates.
- Verification: `bun test src/server/services/comparisonProjectServingRollupBuilder.test.ts`; `bun test src/server/services/comparisonProjectServingRebuildService.test.ts`; scoped ESLint.

## 2026-06-12 - Judgment Queue Refill

- Error: `Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` from `[cron] runAddToQueue`.
- Context: Raw summary-mode judgment queue refill query over `dirty_scope_candidate` and `app.judgment_human_summary`.
- Cause: The refill path sorted a broad summary-priority candidate bucket by article activity before applying the small queue limit.
- Fix: Queue-only raw summary scans now stage bounded `summary_article_candidate` IDs and order by article ID before joining dirty/scope article tables.
- Verification: `bun test src/services/olap/duckdbOlap.test.ts`; `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`; scoped ESLint.
