# Rebuild Better Plan

## Target

- [ ] Support projects with 2M scoped articles.
- [ ] Keep API, judging, imports, and UI reads responsive while rebuilds run.
- [ ] Prefer eventual consistency over blocking promotion or cleanup.
- [ ] Resume safely after process crash, restart, or lease expiry.
- [ ] Keep the design simple: bounded batches, durable cursors, small transactions.

## Principles

- [ ] Dirty article work must stay incremental by default, regardless of project size.
- [ ] Full large rebuilds are for structural changes, recovery, or explicit operator action.
- [ ] Every batch commits independently and can be retried idempotently.
- [ ] Reads continue from the active generation until a staged generation is ready.
- [ ] Promotion should be metadata-only; cleanup should be lazy and bounded.

## Checklist

- [ ] Replace the dirty-article threshold that routes small churn into full rebuilds.
- [ ] Process dirty articles in claim-sized batches instead of loading all dirty IDs into JS.
- [ ] Add a batched `refreshProjectArticleServingBatch(projectId, articleIds)` path.
- [ ] Use a DuckDB temp or staging batch table instead of generated `IN (...)` lists.
- [ ] Complete dirty article state per processed batch, then advance project ACK when claim work is done.
- [ ] Build `mart.project_scope_article` once during structural rebuild setup.
- [ ] Read later rebuild phases from `mart.project_scope_article`, not from route/curated scope CTEs.
- [ ] Keep phase cursor state durable as `(phase, article_created_at, article_id, refresh_token)`.
- [ ] Make each phase delete and insert the current batch idempotently.
- [ ] Keep all heavy rebuild reads and writes on the background DuckDB queue.
- [ ] Add a per-wake time budget so rebuild work yields regularly to other processes.
- [ ] Avoid full-table `DROP TABLE`/rewrite during serving finalization.
- [ ] Promote staged serving rows by updating `active_generation` only.
- [ ] Move old-generation cleanup into separate bounded maintenance batches.
- [ ] Add cleanup cursor state only if old-generation cleanup cannot reuse existing batch helpers.
- [ ] Surface stale-but-usable UI state while a large rebuild is active.
- [ ] Track per-phase rows/sec, batch duration, queue wait, temp spill, and memory.
- [ ] Add an operator-safe admin run mode with `maxCycles`, `batchSize`, and time budget.
- [ ] Add a synthetic 2M-article benchmark script or fixture for local/manual verification.
- [ ] Keep multi-project concurrency out of scope until one-project batching is proven.

## Success Criteria

- [ ] Ten dirty articles in a 2M-article project refresh only those ten articles.
- [ ] A structural 2M-article rebuild can run for hours without blocking normal reads or writes.
- [ ] Restarting mid-phase resumes from the last committed cursor.
- [ ] Promotion is fast and does not wait for old-generation cleanup.
- [ ] Dirty ACKs advance after staged promotion, with later cleanup allowed to lag.
- [ ] Temp spill, RSS, and DuckDB queue wait stay observable during the run.

## Quality Gates

- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/services/projectMartRefreshStateService.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildRunner.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- [ ] `bun test src/server/routes/AdminInvestigateRoutes.test.ts`
- [ ] `bun run lint`
- [ ] Manual 2M synthetic run: cursor advances, API remains responsive, restart resumes, promotion is fast.
