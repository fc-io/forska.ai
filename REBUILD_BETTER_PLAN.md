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
- [ ] Keep active serving generations internally consistent: dictionary IDs, filter members, serving rows, and details must agree for the currently active generation throughout rebuilds.
- [ ] Remove obsolete refresh paths and mart tables after callers move; do not keep compatibility shims or parallel maintenance paths.

## Current Issues To Fix

- [ ] `projectMartRefreshWorker` still routes more than the small dirty-article threshold into full refresh or large rebuild; dirty-article churn must stay incremental regardless of project scope.
- [ ] Dirty project claims currently load all dirty article IDs before choosing the path; claims need bounded DB-side batches and per-batch completion.
- [ ] `refreshJudgmentFactsForProjectClaim` rewrites `mart.judgment_fact`; it should replace only dirty article facts and preserve unrelated articles.
- [ ] `mart.judgment_fact` is global by `judgment_id`, not project-scoped; deletes must target dirty `article_id` rows and must also remove deleted/stale judgments for those articles.
- [ ] Incremental serving refresh currently handles one article at a time; it needs a batch API that mutates the active generation for many project/article pairs in one small transaction.
- [ ] Large rebuild later-phase batch enumeration and some progress projections use route/curated scope CTEs; after scope setup, they should scan `mart.project_scope_article`.
- [ ] Large rebuild state has `target_generation`, but executor SQL still derives `active_generation + 1`; initialize one fixed target generation per rebuild and use it for every staging write and promotion.
- [ ] `app.review_answer_dictionary` is not generationed; never reset or renumber it while active-generation filter rows can still reference existing IDs.
- [ ] Large rebuild dictionary maintenance is a single project-wide reset and `DISTINCT` scan; it needs bounded append-only work or generationed state before 2M runs.
- [ ] Large rebuild judgment reset deletes `mart.judgment_fact` by `project_id` even though the table is global; it must preserve facts that other projects can still read.
- [x] Obsolete `mart.review_article_filter_row` maintenance removed from schema, refresh code, and tests instead of batch-maintaining it.
- [ ] Serving finalization still rewrites generation tables during cleanup; promotion should be only `active_generation` update and old-generation cleanup should be separate bounded work.
- [ ] Incremental serving refresh recomputes per-article scope from live route/curated CTEs instead of updating `mart.project_scope_article` first; scope deltas need one shared batch source of truth.
- [ ] Incremental serving refresh updates active serving, detail, and filter-member rows directly but bypasses `mart.prompt_answer_fact` and `mart.review_article_rollup`; those marts can stay stale after dirty article work.
- [ ] Incremental serving refresh falls back to `refreshProject(projectId)` when no active serving generation exists; cold-start or missing-generation repair must use bounded setup or large rebuild work instead.
- [ ] A quarantined dirty article can block claiming the whole project; refresh should continue processing non-quarantined dirty articles and surface the quarantined subset separately.
- [ ] Obsolete `app.mart_refresh_queue` project tasks still call `refreshProject(projectId)`; migrate `queueProjectRefresh`, prompt-change, route-change, archive, and unarchive callers to bounded dirty-state or large-rebuild paths, then delete the project-task path.
- [ ] Large rebuild admin and heartbeat runners stop by `maxCycles` only; long cycles need a wall-clock budget so a wake cannot monopolize the background queue.
- [ ] Large rebuild scope materialization is folded into the `judgment_fact` phase and cursor; scope setup needs its own durable phase or explicit sub-cursor before fact phases rely on frozen scope rows.
- [ ] Runtime diagnostics expose cycle counts, queue deltas, and process RSS, but not true rows/sec per phase or DuckDB temp spill; observability needs row counts and spill measurements tied to committed cursors.
- [ ] Archived-project purge/delete still uses unbounded mart deletes and table rebuilds in some paths; large archived projects need bounded cleanup work behind active refresh and judging.
- [ ] Archived-project delete detaches `app.judgment.project_id` but does not refresh matching global `mart.judgment_fact` rows; article detail reads can expose stale deleted-project ownership metadata.
- [ ] Queued project refresh rows for archived or deleted projects can remain incomplete because project-task selection filters them out; cleanup needs to prune or complete those queue rows explicitly.

## Incremental Path

- [ ] Replace the dirty-article threshold that routes dirty-article churn into full refresh or large rebuild work.
- [ ] Process dirty articles in claim-sized DB-side batches instead of loading all dirty IDs into JS.
- [ ] Add `refreshProjectArticleServingBatch(projectId, articleIds)` as the default refresh path.
- [ ] Use a DuckDB temp or staging batch table for batch article IDs instead of generated `IN (...)` lists.
- [ ] Replace `mart.judgment_fact` rows for dirty `article_id` values only, including deletion of removed judgments.
- [ ] Delete and reinsert affected `project_id + article_id` rows in `mart.prompt_answer_fact`.
- [ ] Delete and reinsert affected `project_id + article_id` rows in `mart.review_article_rollup`.
- [ ] Delete and reinsert affected active-generation `project_id + article_id` rows in `mart.review_article_serving`.
- [ ] Delete and reinsert affected active-generation `project_id + article_id` rows in `mart.review_article_serving_detail`.
- [ ] Delete and reinsert affected active-generation `project_id + article_id` rows in `mart.review_article_filter_member`.
- [ ] Append missing `app.review_answer_dictionary` values without renumbering existing answers.
- [ ] Refresh `mart.project_scope_article` for retained dirty articles before downstream fact/serving work so scope flags and article timestamps stay current.
- [ ] Handle added scope articles by appending scope rows and refreshing only those articles.
- [ ] Handle removed scope articles by deleting only those project/article rows from active marts.
- [ ] Skip quarantined dirty articles within a claim batch, keep their quarantine status visible, and continue refreshing non-quarantined dirty articles.
- [ ] Queue bounded initial serving setup or large rebuild when a dirty article reaches a project without an active serving generation; do not call full project refresh from the per-article path.
- [ ] Replace obsolete project queue refreshes with dirty-state marking or guarded large-rebuild enqueueing, then remove the project queue API and direct `refreshProject` normal path.
- [ ] Complete dirty article state per processed batch, advance `last_completed_refresh_token` only when all batches through the claim are durable, then publish ACKs.

## Occasional Rebuild Path

- [ ] Keep full rebuild available for structural changes and repair only.
- [ ] Build `mart.project_scope_article` once, in bounded batches, during rebuild setup, and finish scope materialization before fact phases depend on it.
- [ ] Make scope setup resumable separately from judgment fact refresh, either as a first-class `project_scope_article` phase or as a persisted sub-phase with its own cursor.
- [ ] Read later rebuild phases and progress estimates from `mart.project_scope_article`, not route/curated scope CTEs.
- [ ] Initialize missing `target_generation` from the next serving generation (`active_generation + 1`) before the first staging write.
- [ ] Keep phase cursor state durable as `(phase, article_created_at, article_id, refresh_token, target_generation)` and carry the stored `target_generation` unchanged across phase transitions.
- [ ] Make each phase delete and insert the current batch idempotently.
- [ ] Replace project-owned `mart.judgment_fact` reset with scoped article batches so global facts remain available to unrelated projects.
- [ ] Keep all heavy rebuild reads and writes on the background DuckDB queue.
- [ ] Add a wall-clock per-wake time budget, separate from `maxCycles`, so rebuild work yields regularly to other processes.
- [ ] Avoid full-table `DROP TABLE`/rewrite during serving finalization.
- [ ] Promote staged serving rows by setting `active_generation` to the stored `target_generation` only.
- [ ] Move old-generation cleanup into separate bounded maintenance batches.
- [ ] Move archived-project mart cleanup into bounded maintenance batches and keep global/shared judgment facts valid after archived project deletion.
- [ ] Refresh or detach global `mart.judgment_fact` rows affected by archived project deletion without deleting facts still visible to non-archived projects.
- [ ] Complete or prune `app.mart_refresh_queue` rows for archived or deleted projects as part of bounded cleanup, then remove obsolete project queue handling.
- [ ] Delete `queueProjectRefresh` after migrating callers; replacement callers should write dirty-state or queue large-rebuild work directly.
- [ ] Keep `app.review_answer_dictionary` append-only during rebuild, or introduce generationed dictionary state before any rebuild path can renumber IDs.

## Non-Blocking Behavior

- [ ] Prefer stale-but-usable UI data over blocking reads during catch-up.
- [ ] Show dirty counts and last processed batch time when marts lag.
- [ ] Keep cleanup behind refresh and judging work in priority.
- [ ] Keep archived-project purge and old-generation cleanup behind refresh and judging work in priority.
- [ ] Track rows/sec from committed batch row counts, batch duration, queue wait, temp spill, RSS, and last committed cursor per phase.
- [ ] Extend the automatic large-rebuild heartbeat and existing operator-safe admin run route with a wall-clock time budget alongside `maxCycles` and `batchSize`.
- [ ] Keep multi-project concurrency out of scope until one-project batching is proven.

## Success Criteria

- [ ] Ten dirty articles in a 2M-article project refresh only those ten articles.
- [ ] Normal judgment churn is `O(dirty articles)`, not `O(project scope)`.
- [ ] A structural 2M-article rebuild can run for hours without blocking normal reads or writes.
- [ ] Restarting mid-batch replays safely; restarting mid-phase resumes from the last committed cursor.
- [ ] Promotion is fast and does not wait for old-generation cleanup.
- [ ] Cleanup can lag without blocking ACKs or UI reads.
- [ ] Temp spill, RSS, and DuckDB queue wait stay observable during the run.
- [ ] Filtered review reads keep returning correct labels/results while a large rebuild is in progress.

## Test Strategy

- [ ] Add or update tests with each implementation slice before relying on manual 2M verification.
- [ ] Prefer DB-backed service tests over mocked SQL for mart correctness, using small fixtures that prove row-level invariants.
- [ ] Cover incremental dirty batches for one article, exactly threshold-sized batches, over-threshold batches, no-active-generation fallback, and a large-scope project that must not trigger a full refresh.
- [ ] Cover judgment changes, judgment deletion, human review changes, retained-scope article metadata or scope-flag changes, scope add, scope remove, and quarantined dirty articles as separate dirty paths.
- [ ] Assert dirty batches only mutate the expected `project_id + article_id` rows and preserve unrelated projects/articles.
- [ ] Assert incremental refresh keeps `mart.prompt_answer_fact`, `mart.review_article_rollup`, active serving, details, and filter members in sync for the same dirty article set.
- [ ] Assert `app.review_answer_dictionary` appends new answers without renumbering existing IDs and keeps active `review_article_filter_member` rows valid.
- [ ] Assert serving, detail, and filter-member rows always agree on the same active generation after incremental refresh, rebuild promotion, and cleanup lag.
- [ ] Assert large rebuild judgment fact batches preserve facts still visible to other projects sharing articles, prompts, models, and content settings.
- [ ] Assert scope setup resumes independently from judgment fact work and progress displays do not treat partially materialized scope as the final denominator.
- [ ] Assert former `queueProjectRefresh` triggers for prompt changes, route changes, archive, and unarchive write dirty-state or large-rebuild work directly and no longer depend on project queue compatibility.
- [ ] Assert large rebuild phases are idempotent by replaying a completed batch, expiring a lease, and resuming from the stored cursor.
- [ ] Assert later large rebuild phases and operator/job progress stay tied to the frozen scope rows when route or curated scope changes mid-rebuild.
- [ ] Assert old-generation cleanup can run later without changing active-generation review results or filter counts.
- [ ] Assert archived-project cleanup runs in bounded batches and preserves global judgment facts still visible to non-archived projects.
- [ ] Assert archived-project deletion refreshes or detaches `mart.judgment_fact` ownership metadata and does not leave queued project refresh rows stuck forever.
- [ ] Assert API and OLAP review filters and article review details return the same active-generation data before refresh, during queued/running work, after promotion, and after cleanup.
- [ ] Keep performance tests deterministic: synthetic 2M data should validate bounded dirty-batch work, queue wait observability, and memory/spill reporting, not exact timings.
- [ ] For shared review UI/API behavior, smoke both browser/web and desktop flows after the server-side gates pass.

## Quality Gates

- [ ] `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- [ ] `bun test src/server/services/projectMartRefreshStateService.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildStateService.test.ts`
- [ ] `bun test src/server/services/getDuckdbMartRefreshService.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildRunner.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildCyclesService.test.ts`
- [ ] `bun test src/db/migrateDuckdb.test.ts`
- [ ] `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- [ ] `bun test src/server/utils/projectMartRefreshWorkerHeartbeat.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
- [ ] `bun test src/server/routes/ProjectsRoutes.test.ts`
- [ ] `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- [ ] `bun test src/server/routes/AdminInvestigateRoutes.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] `bun run lint`
- [ ] Manual 2M synthetic run: incremental dirty batch stays small, API remains responsive, restart resumes, promotion is fast.
- [ ] Manual browser and desktop reviews-page smoke: active data remains usable while refresh or rebuild work is queued/running.
