# Rebuild Better Plan

## Target

- [ ] Support projects with 2M scoped articles.
- [ ] Make incremental append/upsert mart maintenance the normal path.
- [ ] Keep API, judging, imports, and UI reads responsive during maintenance.
- [ ] Accept eventual consistency; never block readers on catch-up or cleanup.
- [ ] Resume safely after process crash, restart, or lease expiry.
- [ ] Keep the design simple: bounded batches, durable cursors, small transactions.

## Principles

- [ ] Do not rebuild from scratch for normal judgment, human-review, or article churn.
- [ ] Treat marts as maintained indexes: append new facts and replace affected project/article rows.
- [ ] Full rebuilds are rare maintenance for repair, compaction, schema/rule changes, or explicit operator action.
- [ ] Every batch commits independently and can be retried idempotently.
- [ ] Current reads use the best available mart state while background work catches up.

## Incremental Path

- [ ] Replace the dirty-article threshold that routes small churn into full rebuilds.
- [ ] Process dirty articles in claim-sized batches instead of loading all dirty IDs into JS.
- [ ] Add `refreshProjectArticleServingBatch(projectId, articleIds)` as the default refresh path.
- [ ] Use a DuckDB temp or staging batch table instead of generated `IN (...)` lists.
- [ ] Append/upsert `mart.judgment_fact` for new or changed judgments.
- [ ] Delete and reinsert affected `project_id + article_id` rows in `mart.prompt_answer_fact`.
- [ ] Delete and reinsert affected `project_id + article_id` rows in `mart.review_article_rollup`.
- [ ] Delete and reinsert affected `project_id + article_id` rows in `mart.review_article_serving`.
- [ ] Delete and reinsert affected `project_id + article_id` rows in `mart.review_article_serving_detail`.
- [ ] Delete and reinsert affected `project_id + article_id` rows in `mart.review_article_filter_member`.
- [ ] Append missing `app.review_answer_dictionary` values without renumbering existing answers.
- [ ] Handle added scope articles by appending scope rows and refreshing only those articles.
- [ ] Handle removed scope articles by deleting only those project/article rows from active marts.
- [ ] Complete dirty article state per processed batch, then publish ACKs as batches become durable.

## Occasional Rebuild Path

- [ ] Keep full rebuild available for structural changes and repair only.
- [ ] Build `mart.project_scope_article` once during rebuild setup.
- [ ] Read later rebuild phases from `mart.project_scope_article`, not route/curated scope CTEs.
- [ ] Keep phase cursor state durable as `(phase, article_created_at, article_id, refresh_token)`.
- [ ] Make each phase delete and insert the current batch idempotently.
- [ ] Keep all heavy rebuild reads and writes on the background DuckDB queue.
- [ ] Add a per-wake time budget so rebuild work yields regularly to other processes.
- [ ] Avoid full-table `DROP TABLE`/rewrite during serving finalization.
- [ ] Promote staged serving rows by updating `active_generation` only.
- [ ] Move old-generation cleanup into separate bounded maintenance batches.

## Non-Blocking Behavior

- [ ] Prefer stale-but-usable UI data over blocking reads during catch-up.
- [ ] Show dirty counts and last processed batch time when marts lag.
- [ ] Keep cleanup behind refresh and judging work in priority.
- [ ] Track rows/sec, batch duration, queue wait, temp spill, RSS, and last committed cursor.
- [ ] Add an operator-safe admin run mode with `maxCycles`, `batchSize`, and time budget.
- [ ] Keep multi-project concurrency out of scope until one-project batching is proven.

## Success Criteria

- [ ] Ten dirty articles in a 2M-article project refresh only those ten articles.
- [ ] Normal judgment churn is `O(dirty articles)`, not `O(project scope)`.
- [ ] A structural 2M-article rebuild can run for hours without blocking normal reads or writes.
- [ ] Restarting mid-batch replays safely; restarting mid-phase resumes from the last committed cursor.
- [ ] Promotion is fast and does not wait for old-generation cleanup.
- [ ] Cleanup can lag without blocking ACKs or UI reads.
- [ ] Temp spill, RSS, and DuckDB queue wait stay observable during the run.

## Quality Gates

- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/services/projectMartRefreshStateService.test.ts`
- [ ] `bun test src/server/services/getDuckdbMartRefreshService.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildRunner.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- [ ] `bun test src/server/routes/AdminInvestigateRoutes.test.ts`
- [ ] `bun run lint`
- [ ] Manual 2M synthetic run: incremental dirty batch stays small, API remains responsive, restart resumes, promotion is fast.
