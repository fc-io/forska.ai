# Rebuild 2 Plan

## Final Targets

- [ ] Support projects with 2M scoped articles.
- [ ] Make incremental append/upsert mart maintenance the normal path everywhere.
- [ ] Keep API, judging, imports, and UI reads responsive during maintenance.
- [ ] Accept eventual consistency; never block readers on catch-up or cleanup.
- [ ] Resume safely after process crash, restart, or lease expiry across dirty materialization, dirty refresh, and large rebuild work.
- [ ] Keep the design simple: bounded batches, durable cursors, small transactions.

## Remaining Principles

- [ ] Do not rebuild from scratch for normal judgment, human-review, or article churn.
- [ ] Treat marts as maintained indexes: append new facts and replace affected project/article rows.
- [ ] Full rebuilds should be rare maintenance for repair, compaction, schema/rule changes, or explicit operator action.
- [ ] Every batch must commit independently and be retried idempotently.
- [ ] Current reads should use the best available mart state while background work catches up.
- [ ] Keep active serving generations internally consistent: dictionary IDs, filter members, serving rows, and details must agree for the active generation throughout rebuilds.
- [ ] Remove obsolete refresh paths and mart tables after callers move; do not keep compatibility shims or parallel maintenance paths.
- [ ] Do not preserve intermediate queue, dirty-state, rebuild-state, or mart-maintenance rows for backward compatibility; clear or rebuild obsolete intermediate state during cutover when that makes the implementation simpler and safer.
- [ ] Cutover clearing must be explicit and worker-quiesced: pause refresh/rebuild/queue drains, clear obsolete intermediate state, rederive replacement dirty or rebuild work from source-of-truth tables, then resume workers.
- [ ] Never publish ACKs or advance completed tokens merely because obsolete intermediate state was cleared during cutover.

## Dirty-State Materialization And Callers

- [ ] Replace project-wide dirty-state creation that materializes scoped article IDs in JS with DB-side `INSERT ... SELECT` batches against route scope, curated scope, project date-window constraints, and existing `mart.project_scope_article` rows.
- [ ] Add durable project-wide dirty materialization state with source kind, target dirty token, cursor, inserted row count, status, and timestamps.
- [ ] Ensure claim workers cannot see or ACK a project-wide dirty token until its article-state materialization completes.
- [ ] Migrate prompt changes, project create/edit/clone settings changes, route/import-store changes, project-article and subproject scope mutations, human assessment submissions, article import changes, archive/unarchive, backfill, purge, repair scripts, and judgment refresh callers to dirty-state or guarded large-rebuild writes directly.
- [ ] Replace generated dirty article `VALUES` and `IN (...)` lists with DuckDB temp or staging batch tables throughout incremental refresh SQL.
- [ ] Consolidate or otherwise prove incremental batch refresh transaction boundaries keep active serving rows, details, and filter members internally consistent for each committed batch.
- [ ] Add an incremental refresh worker wall-clock wake budget with durable resume after each committed dirty batch.
- [ ] Retire direct `refreshProject(projectId)` as a normal compatibility path; keep only explicit repair or structural operator flows.
- [ ] Add a cutover migration or maintenance step that clears obsolete in-flight dirty, queue, and rebuild intermediate state only while workers are paused, then immediately requeues dirty state or large rebuilds from current source-of-truth tables before workers resume.
- [ ] During cutover, also complete or clear stale `app.maintenance_work_lease` rows for obsolete review-index project refresh, large rebuild, and archived-project recovery work so the warnings API cannot report cleared work as still active or recoverable.

## Queue Removal

- [ ] Migrate `queueProjectRefresh`, `queueProjectRefreshes`, `queueProjectRefreshesByImportRouteIds`, `queueProjectRefreshesByPromptIds`, `queueJudgmentArticleRefresh`, `queueJudgmentArticleRefreshes`, `queueJudgmentArticleRefreshesByJudgmentIds`, `queueJudgmentArticleRefreshesByPromptIds`, and `judgeStoreJudgment` to dirty-state.
- [ ] Make the `judgeStoreJudgment` replacement atomic with judgment persistence so stored judgments cannot commit without corresponding dirty-state work.
- [ ] Migrate remaining import-store, archive, unarchive, backfill, purge, and repair-script callers away from `app.mart_refresh_queue`.
- [ ] Clear all remaining legacy `app.mart_refresh_queue` rows during cutover instead of draining them for compatibility.
- [ ] Delete `app.mart_refresh_queue`, queue schema repair code, auto-drain code, queue APIs, queue CLI/package scripts, queue tests, and queue pruning compatibility code.
- [ ] Remove queue exports/imports and the table in the same implementation slice so no live caller can recreate queue rows after cutover; do not leave no-op compatibility wrappers.
- [ ] Remove archived refresh queue recovery and drain heartbeat quality gates when those compatibility paths are deleted.

## Quarantine And ACK Semantics

- [ ] Define and implement the quarantine ACK barrier: quarantined article rows remain durable with quarantine metadata, and project `last_completed_refresh_token` plus external ACK must not advance past the earliest unresolved quarantined dirty token.
- [ ] Continue processing non-quarantined dirty rows while keeping project completion and ACK behind unresolved quarantined rows.
- [ ] Record processed-but-not-ACKable dirty article rows past a quarantine barrier so later rows do not reprocess forever while ACK remains blocked by an earlier quarantined token.
- [ ] If a processed-but-not-ACKable article becomes dirty again before the barrier resolves, preserve or extend its dirty token and require it to be processed again before ACK can advance.
- [ ] Prune processed dirty article rows only after every earlier quarantined token is resolved and the project ACK can advance safely.
- [ ] When all remaining claim rows are quarantined, release or park the claim as blocked-by-quarantine instead of failing for no progress or recursively reclaiming forever.
- [ ] Add explicit unquarantine/retry or bounded cleanup semantics before a quarantined row can be ACKed or pruned.

## Large Rebuild Hardening

- [ ] Guard large rebuild cursor/state resets by worker, lease, phase, token, and target generation so stale workers after lease expiry cannot overwrite newer state; zero-row updates must be treated as lost lease with no ACK or phase advancement.
- [ ] Make every large rebuild phase strictly delete and insert only the current batch; remove or prove safe the whole-project or phase-setup resets still used for scope setup, prompt-answer fact, rollup, and target-generation serving/filter/detail setup.
- [ ] Retire or replace the old full-refresh dictionary rebuild path that deletes and renumbers `app.review_answer_dictionary` while active-generation filter rows may reference existing IDs.
- [ ] Keep full rebuild available for structural changes and repair only, not normal refresh work.

## Archived Project Cleanup

- [ ] Move archived-project delete off synchronous full purge and table rebuilds; use bounded cleanup behind active refresh and judging work.
- [ ] Retire or rework `scripts/purgeArchivedProjectMarts.ts` and the `db:duck:purge-archived-marts` package script so archived cleanup uses the new bounded tombstone cleanup path and does not keep a stale hard-coded mart table allowlist.
- [ ] Define archived-project deletion lifecycle explicitly: mark projects as delete-pending/tombstoned, hide them from normal API/UI reads, keep enough project identity for bounded cleanup, then delete source rows only after cleanup completes.
- [ ] Store tombstoned project cleanup identity in a table that bounded cleanup workers can scan without relying on visible `app.project` rows.
- [ ] Refresh, recompute, or detach global `mart.judgment_fact` ownership metadata affected by archived project deletion without deleting facts still visible to non-archived projects.
- [ ] Preserve global/shared judgment facts after archived project deletion in all cleanup paths.
- [ ] Clear all legacy `app.mart_refresh_queue` rows for archived or deleted projects, including remaining `judgment_article` rows, as part of queue cutover.
- [ ] Include per-project app-side mart metadata (`app.review_answer_dictionary`, `app.project_review_serving_generation`) in bounded archived cleanup while preserving shared/global judgment facts.

## Observability And UI

- [ ] Keep detailed rows/sec, RSS, temp spill, and queue-wait diagnostics API/admin-only; the review-page banner should only show user-actionable status, counts, and last-progress timestamps.
- [ ] Add comparable committed row, queue wait, RSS, temp spill, and budget diagnostics for incremental dirty-refresh wakes after the incremental wake budget exists.
- [ ] Keep review warnings API and review indexing copy in sync with new dirty/materialization/quarantine states without exposing admin-only diagnostics in the user banner.
- [ ] Smoke browser/web and desktop review flows after server-side gates pass.

## Success Criteria

- [ ] Ten dirty articles in a 2M-article project refresh only those ten articles.
- [ ] Normal judgment churn is `O(dirty articles)`, not `O(project scope)`.
- [ ] A structural 2M-article rebuild can run for hours without blocking normal reads or writes.
- [ ] Restarting mid-batch replays safely; restarting mid-phase resumes from the last committed cursor.
- [ ] Promotion is fast and does not wait for old-generation cleanup.
- [ ] Cleanup can lag without blocking ACKs or UI reads.
- [ ] Quarantined dirty articles are visible and durable, but project ACKs do not advance past unresolved quarantined dirty tokens.
- [ ] Crashing during project-wide dirty materialization resumes safely and never lets workers process or ACK a partial dirty set.
- [ ] Temp spill, RSS, and DuckDB queue wait stay observable during the run.
- [ ] Filtered review reads keep returning correct labels/results while a large rebuild is in progress.

## Remaining Test Strategy

- [ ] Add or update tests with each remaining implementation slice before relying on manual 2M verification.
- [ ] Prefer DB-backed service tests over mocked SQL for mart correctness, using small fixtures that prove row-level invariants.
- [ ] Assert project-wide dirty-state writes for prompt changes, route/import-store changes, backfill, repair, and project-level marks use DB-side `INSERT ... SELECT` batches with project date-window constraints, maintain durable materialization cursor/status, do not materialize scoped article IDs in JS, and do not expose claimable tokens until materialization completes.
- [ ] Assert cutover pauses workers, clears obsolete intermediate state and stale maintenance leases, rederives replacement work from source-of-truth tables, resumes workers, and does not publish ACKs from clearing alone.
- [ ] Assert former `queueProjectRefresh` and `queueJudgmentArticleRefresh` triggers for judgment changes, prompt changes, route/import-store changes, archive, unarchive, backfill, purge, and repair-script work write dirty-state or large-rebuild work directly and no longer depend on `app.mart_refresh_queue` compatibility.
- [ ] Assert project create/edit/clone, project-article deletes, subproject creation, human assessment submission, prompt edits, and import-store writes mark the exact affected project/article dirty state and do not recreate queue rows.
- [ ] Assert queue cutover clears existing `app.mart_refresh_queue` rows, drops/removes the queue path, and cannot recreate queue rows from any former caller.
- [ ] Assert `judgeStoreJudgment` stores the judgment and marks affected projects dirty atomically; if dirty-state marking fails, the judgment write cannot be silently committed as refreshed.
- [ ] Assert incremental refresh worker wakes stop on wall-clock budget, leave durable dirty-state progress, and resume the next wake without reprocessing completed batches.
- [ ] Assert a claim with quarantined rows processes non-quarantined rows, does not publish ACK or advance `last_completed_refresh_token` past the quarantine barrier, releases or parks without failure when only quarantined rows remain, and resumes after explicit unquarantine/retry or bounded cleanup.
- [ ] Assert processed dirty rows after a quarantine barrier are not reprocessed on every wake, are reopened if they become dirty again, and are only pruned once the barrier resolves and ACK advances.
- [ ] Assert `app.review_answer_dictionary` appends new answers without renumbering existing IDs across all remaining refresh paths and keeps active `review_article_filter_member` rows valid.
- [ ] Assert serving, detail, and filter-member rows always agree on the same active generation after incremental refresh, rebuild promotion, and cleanup lag.
- [ ] Assert large rebuild phases are idempotent by replaying a completed batch, expiring a lease, and resuming from the stored cursor.
- [ ] Assert an expired large rebuild worker cannot overwrite cursor, phase, refresh token, or `target_generation` after another worker has reclaimed the rebuild.
- [ ] Assert later large rebuild phases and operator/job progress stay tied to frozen scope rows when route or curated scope changes mid-rebuild.
- [ ] Assert archived-project delete-pending/tombstone state hides projects from normal API/UI reads while preserving enough identity for bounded cleanup to finish and final deletion to clear the tombstone.
- [ ] Assert archived-project cleanup runs in bounded batches and preserves global judgment facts still visible to non-archived projects.
- [ ] Assert archived-project deletion refreshes or detaches `mart.judgment_fact` ownership metadata and does not leave legacy `app.mart_refresh_queue` rows stuck forever during migration.
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
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts`
- [ ] `bun test src/server/routes/ProjectsRoutes.test.ts`
- [ ] `bun test src/server/routes/PromptsRoutes.test.ts`
- [ ] `bun test src/server/routes/SubprojectsRoutes.test.ts`
- [ ] `bun test src/server/routes/SubprojectsRoutes.rollback.test.ts`
- [ ] `bun test src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts`
- [ ] `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts`
- [ ] `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
- [ ] `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.test.ts`
- [ ] `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- [ ] `bun test src/server/routes/AdminInvestigateRoutes.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- [ ] `bun test src/server/utils/martRefreshDrainHeartbeat.test.ts`
- [ ] `bun test src/server/services/articleImportStoreService.test.ts`
- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] `bun test src/components/main/reviews/getReviewIndexingInProgressTitle.test.ts`
- [ ] `bunx vitest run src/components/main/reviews/reviewsProjectWarnings.vitest.tsx`
- [ ] `bun test scripts/projectMartRefreshRecovery.test.ts`
- [ ] `bun test scripts/recoverArchivedProjectRefreshQueue.test.ts`
- [ ] `bun run db:mig`
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] `bun run desktop:build`
- [ ] Manual 2M synthetic run: incremental dirty batch stays small, API remains responsive, restart resumes, promotion is fast.
- [ ] Manual browser and desktop reviews-page smoke: active data remains usable while refresh or rebuild work is queued/running.
