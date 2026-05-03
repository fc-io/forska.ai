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
- [ ] Cutover clearing must be explicit, worker-quiesced, and fenced: pause refresh/rebuild/queue drains, clear obsolete intermediate state, rederive replacement dirty or rebuild work from source-of-truth tables, then resume workers.
- [ ] Never publish ACKs or advance completed tokens merely because obsolete intermediate state was cleared during cutover.
- [ ] Cutover must hold a durable exclusive fence read by maintenance workers and refresh/queue write APIs: while the fence is active, workers must not claim, ACK, or complete refresh/rebuild/queue work, and legacy queue APIs must reject writes instead of accepting rows.
- [ ] Do not clear legacy state until code paths that can recreate it are removed or guarded by the cutover fence; post-cutover verification must prove legacy rows cannot be recreated.

## Dirty-State Materialization And Callers

- [ ] Replace project-wide dirty-state creation that materializes scoped article IDs in JS with DB-side `INSERT ... SELECT` batches against route scope, curated scope, project date-window constraints, and existing `mart.project_scope_article` rows.
- [ ] Add durable project-wide dirty materialization state with source kind, target dirty token, cursor, inserted row count, source scope snapshot/high-water or fingerprint, status, and timestamps.
- [ ] Ensure claim workers cannot see or ACK a project-wide dirty token until its article-state materialization completes.
- [ ] Define project-wide dirty materialization scope stability: each target dirty token must read from one stable source scope snapshot/high-water, and concurrent route/date-window/curated/import scope mutations must create a later dirty token instead of mixing source states under the current token.
- [ ] Update judgment-job unassessed count/article routes to treat incomplete project-wide dirty materialization and unresolved quarantine barriers as not-fully-fresh, using raw fallback or explicit pending state without caching a stale OLAP count as fresh.
- [ ] Migrate prompt changes, project create/edit/clone settings changes, route/import-store changes, project-article and subproject scope mutations, human assessment submissions, article import changes, archive/unarchive, backfill, purge, repair scripts, and judgment refresh callers to dirty-state or guarded large-rebuild writes directly.
- [ ] Rework `scripts/repairOwnedProjectPrompts.ts` so repaired prompt/judgment rows create replacement dirty work through the new DB-side project-wide dirty materialization path, with durable cursor/status, instead of relying on a JS-collected project-id list and immediate project-level dirty marking.
- [ ] Replace generated dirty article `VALUES` and `IN (...)` lists with DuckDB temp or staging batch tables throughout incremental refresh SQL.
- [ ] Consolidate or otherwise prove incremental batch refresh transaction boundaries keep `mart.project_scope_article`, `mart.prompt_answer_fact`, `app.review_answer_dictionary`, `mart.review_article_rollup`, `mart.review_article_serving`, `mart.review_article_serving_detail`, and `mart.review_article_filter_member` internally consistent for each committed batch.
- [ ] Add an incremental refresh worker wall-clock wake budget with durable resume after each committed dirty batch.
- [ ] Retire direct `refreshProject(projectId)` from all normal flows; keep only explicit repair or structural operator flows.
- [ ] Add a cutover migration or maintenance step that clears obsolete in-flight dirty, queue, and rebuild intermediate state only while workers are paused and the durable cutover fence is held, then immediately requeues dirty state or large rebuilds from current source-of-truth tables before workers resume.
- [ ] Add an explicit `db:duck:rebuild2-cutover` package command in the same clean-cut slice that removes legacy state paths: acquire the durable cutover fence, pause workers, wait for active workers to stop or leases to expire, make legacy queue APIs reject writes, clear obsolete queue/dirty/rebuild/lease state, rederive replacement dirty or large-rebuild work, verify no legacy queue callers remain, then resume workers and release the fence.
- [ ] During cutover, also complete or clear stale `app.maintenance_work_lease` rows for obsolete review-index article refresh, project refresh, archived-project recovery work, and any large-rebuild lease whose backing rebuild state was cleared or rederived, so the warnings API cannot report cleared work as still active or recoverable.
- [ ] During cutover and judgment-job deletion/start-clean cleanup, complete or clear stale `judgment_sqlite_outbox_import` rows in `app.maintenance_work_lease` and remove orphaned `app.judgment_job_sqlite_health_projection` rows so `/api/judgmentsjobs-health` and `/api/judgmentsjobs/:id/health` cannot report deleted or cleared jobs as active, retrying, or waiting for owner ACK.

## Queue Removal

- [ ] Migrate or rename `queueProjectRefresh`, `queueProjectRefreshes`, `queueProjectRefreshesByImportRouteIds`, `queueProjectRefreshesByPromptIds`, `queueJudgmentArticleRefresh`, `queueJudgmentArticleRefreshes`, `queueJudgmentArticleRefreshesByJudgmentIds`, `queueJudgmentArticleRefreshesByPromptIds`, `queueImportedArticleRefreshes`, and `judgeStoreJudgment` to dirty-state or guarded large-rebuild writes directly.
- [ ] Make the `src/agent/judge/judgeStoreJudgment.ts` / `judgeStoreJudgment` replacement atomic with judgment persistence so stored judgments cannot commit without corresponding dirty-state work.
- [ ] Make `judgmentJobSqliteOutboxImport` crash-safe and idempotent across DuckDB judgment insertion, dirty-state marking, and SQLite outbox ACK/claim completion so imported judgments cannot become visible without corresponding dirty work, and outbox rows cannot be cleared before dirty work is durable.
- [ ] Define and test `judgmentJobSqliteOutboxImport` recovery for crashes after DuckDB insertion before dirty marking, after dirty marking before SQLite ACK, and after SQLite ACK before maintenance-lease completion; do not require a literal cross-store transaction.
- [ ] Migrate remaining import-store, archive, unarchive, backfill, purge, and repair-script callers away from `app.mart_refresh_queue`.
- [ ] Clear all remaining legacy `app.mart_refresh_queue` rows during cutover instead of draining or preserving them, with the cutover fence held and legacy queue writes already rejected.
- [ ] Do not rely on the existing partial `0054_clearProjectMartRefreshQueueProjectTasks.sql` migration for rebuild2 cutover; add a new worker-quiesced cutover migration/command that clears or drops all remaining `app.mart_refresh_queue` rows and covers non-project scopes such as `judgment_article`.
- [ ] Delete `app.mart_refresh_queue`, queue schema repair code, auto-drain code including `src/server/utils/martRefreshDrainHeartbeat.ts` and its `startBackgroundWork` wiring, queue APIs, queue CLI/package scripts including `db:duck:recover-archived-refresh-queue`, queue scripts/tests including `scripts/recoverArchivedProjectRefreshQueue.ts` and `scripts/recoverArchivedProjectRefreshQueue.test.ts`, and legacy queue pruning code.
- [ ] Remove queue exports/imports and the table in the same implementation slice so no live caller can recreate queue rows after cutover; do not leave no-op wrappers.
- [ ] The clean-cut deletion slice must remove archived refresh queue recovery and drain heartbeat paths, tests, and quality gates together, replacing them with dirty-refresh wake/lease and bounded tombstone cleanup gates.

## Quarantine And ACK Semantics

- [ ] Define and implement the quarantine ACK barrier: quarantined article rows remain durable with quarantine metadata, and project `last_completed_refresh_token` plus external ACK must not advance past the earliest unresolved quarantined dirty token.
- [ ] Migrate `app.project_mart_refresh_article_quarantine` from article-only rows to project/article dirty-token-scoped quarantine rows, with indexes that can find the earliest unresolved quarantined token per project; cut over or clear obsolete article-only quarantine rows while workers are paused and the cutover fence is held.
- [ ] Define the durable quarantine/barrier state model before implementation: unresolved quarantine rows keyed by project, article, and dirty token; processed-past-barrier rows must retain processed token/status; redirtied rows must record the reopened token; pruning must prove no earlier unresolved quarantine remains.
- [ ] Continue processing non-quarantined dirty rows while keeping project completion and ACK behind unresolved quarantined rows.
- [ ] Record processed-but-not-ACKable dirty article rows past a quarantine barrier so later rows do not reprocess forever while ACK remains blocked by an earlier quarantined token.
- [ ] If a processed-but-not-ACKable article becomes dirty again before the barrier resolves, preserve or extend its dirty token and require it to be processed again before ACK can advance.
- [ ] Prune processed dirty article rows only after every earlier quarantined token is resolved and the project ACK can advance safely.
- [ ] When all remaining claim rows are quarantined, release or park the claim as blocked-by-quarantine instead of failing for no progress or recursively reclaiming forever.
- [ ] Add explicit unquarantine/retry or bounded cleanup semantics before a quarantined row can be ACKed or pruned.
- [ ] Add CLI coverage for `db:duck:quarantine-refresh-article` and `db:duck:unquarantine-refresh-article`, proving they preserve the ACK barrier, report impacted projects, and only release blocked state through the explicit unquarantine/retry path.

## Large Rebuild Hardening

- [ ] Guard large rebuild cursor/state resets by worker, lease, phase, token, and target generation so stale workers after lease expiry cannot overwrite newer state; zero-row updates must be treated as lost lease with no ACK or phase advancement.
- [ ] Make every large rebuild phase strictly delete and insert only the current batch; remove or prove safe the whole-project or phase-setup resets still used for scope setup, prompt-answer fact, rollup, and target-generation serving/filter/detail setup.
- [ ] Retire or replace the old full-refresh dictionary rebuild path that deletes and renumbers `app.review_answer_dictionary` while active-generation filter rows may reference existing IDs.
- [ ] Keep full rebuild available for structural changes and repair only, not normal refresh work.
- [ ] Retire or rename `db:duck:rebuild-marts`, `db:duck:backfill-review-serving-v3`, `db:duck:refresh-project-once`, `db:duck:run-large-rebuild-cycle`, and `db:duck:run-large-rebuild-cycles`, plus active docs references found by search such as `AGENTS.md` and any current README/docs references, so package scripts and docs make clear they are explicit maintenance-worker/operator repair or staged-rebuild commands, not normal refresh or dirty-maintenance paths.
- [ ] Retire or rework `db:duck:inspect-project-refresh-risk` and `db:duck:recover-project-refresh-claims` so operational CLIs understand durable dirty-materialization state, dirty-token quarantine barriers, project date-window/curated scope, and large-rebuild leases; rename them away from project-refresh claim terminology if they remain.
- [ ] Retire or rework `db:duck:repair-project-refresh-ledger` and `db:duck:repair-judgment-fact` so repair commands do not carry stale hand-written table schemas or drop/recreate live mart/state tables outside the explicit worker-quiesced cutover or structural repair flow.
- [ ] Rename queue-named large rebuild APIs after queue cutover: `queueLargeRebuild`, `queueProjectLargeRebuild`, `queueProjectLargeRebuilds`, `queueLargeRebuildsForDirtyStates`, and `queueProjectLargeRebuildForDirtyArticles` should become staged/schedule/request large-rebuild APIs so no non-queue path keeps queue terminology.
- [ ] Add a rebuild2 migration audit/test for qualified DuckDB `DROP INDEX` migrations, covering duplicate or intentionally repeated index-drop migrations such as `0056`, `0057`, and `0058`, and document whether they must remain separate for already-applied migration history.

## Archived Project Cleanup

- [ ] Move archived-project delete off synchronous full purge and table rebuilds; use bounded cleanup behind active refresh and judging work.
- [ ] Retire or rework `scripts/purgeArchivedProjectMarts.ts`, `scripts/reproArchivedProjectServingDelete.ts`, their tests, and the `db:duck:purge-archived-marts` package script so archived cleanup uses the new bounded tombstone cleanup path and does not keep stale hard-coded mart table allowlists or serving-delete remediation paths.
- [ ] Rework `/api/projects/delete-archived` in `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts` so final archived deletion creates tombstone/delete-pending cleanup work instead of synchronously purging marts and rebuilding app tables in the request path.
- [ ] Define archived-project deletion lifecycle explicitly: mark projects as delete-pending/tombstoned, hide them from normal API/UI reads, keep enough project identity for bounded cleanup, then delete source rows only after cleanup completes.
- [ ] Store tombstoned project cleanup identity in a table that bounded cleanup workers can scan without relying on visible `app.project` rows.
- [ ] Refresh, recompute, or detach global `mart.judgment_fact` ownership metadata affected by archived project deletion without deleting facts still visible to non-archived projects.
- [ ] Preserve global/shared judgment facts after archived project deletion in all cleanup paths.
- [ ] Clear all legacy `app.mart_refresh_queue` rows for archived or deleted projects, including remaining `judgment_article` rows, as part of the fenced queue cutover.
- [ ] Include per-project app-side mart metadata (`app.review_answer_dictionary`, `app.project_review_serving_generation`) in bounded archived cleanup while preserving shared/global judgment facts.

## Observability And UI

- [ ] Keep detailed rows/sec, RSS, temp spill, and DuckDB writer queue-wait diagnostics API/admin-only; the review-page banner should only show user-actionable status, counts, and last-progress timestamps.
- [ ] Add comparable committed row, DuckDB writer queue-wait, RSS, temp spill, and budget diagnostics for incremental dirty-refresh wakes after the incremental wake budget exists.
- [ ] Keep review warnings API and review indexing copy in sync with new dirty/materialization/quarantine states without exposing admin-only diagnostics in the user banner.
- [ ] Smoke browser/web and desktop review flows after server-side gates pass.

## Success Criteria

- [ ] Ten dirty articles in a 2M-article project claim at most those ten article IDs for dirty refresh, do not materialize project scope article IDs in JS, and do not run project-wide downstream deletes for the claim.
- [ ] Normal judgment churn is `O(dirty articles)`, not `O(project scope)`: committed dirty-refresh row counts and query inputs scale with the dirty batch size, excluding bounded dictionary/filter maintenance for touched rows.
- [ ] A structural 2M-article rebuild can run for hours without blocking normal reads or writes: review reads use the active generation, writes can mark later dirty/rebuild work, and maintenance-worker waits are observable rather than hidden in API handlers.
- [ ] Restarting mid-batch replays safely with no duplicate committed mart rows; restarting mid-phase resumes from the last committed cursor and stale workers with expired leases cannot advance state.
- [ ] Promotion is a short active-generation swap transaction, completes before old-generation cleanup starts, and does not wait for old-generation cleanup.
- [ ] Cleanup can lag without blocking ACKs or UI reads; lag is visible as bounded cleanup work, not as reader fallback to obsolete tables.
- [ ] Quarantined dirty articles are visible and durable, but project ACKs do not advance past unresolved quarantined dirty tokens.
- [ ] Crashing during project-wide dirty materialization resumes safely and never lets workers process or ACK a partial dirty set.
- [ ] Temp spill, RSS, and DuckDB writer queue-wait stay observable during the run.
- [ ] Filtered review reads keep returning correct labels/results while a large rebuild is in progress.

## Remaining Test Strategy

- [ ] Add or update tests with each remaining implementation slice before relying on manual 2M verification.
- [ ] Prefer DB-backed service tests over mocked SQL for mart correctness, using small fixtures that prove row-level invariants.
- [ ] Assert project-wide dirty-state writes for prompt changes, route/import-store changes, backfill, repair, and project-level marks use DB-side `INSERT ... SELECT` batches with project date-window constraints, maintain durable materialization cursor/status, do not materialize scoped article IDs in JS, and do not expose claimable tokens until materialization completes.
- [ ] Assert a project-wide materialization token reads one stable source scope snapshot/high-water or records a source fingerprint, and a mid-materialization scope/date-window/curated/import mutation creates later dirty work instead of mixing states under the current token.
- [ ] Assert cutover acquires the durable fence, blocks worker claims/ACKs/completions and legacy queue writes, clears obsolete intermediate state and stale maintenance leases, rederives replacement work from source-of-truth tables, resumes workers, releases the fence, and does not publish ACKs from clearing alone.
- [ ] Assert former `queueProjectRefresh` and `queueJudgmentArticleRefresh` triggers for judgment changes, prompt changes, route/import-store changes, archive, unarchive, backfill, purge, and repair-script work write dirty-state or large-rebuild work directly and no longer depend on legacy `app.mart_refresh_queue` behavior.
- [ ] Assert project create/edit/clone, project-article deletes, subproject creation, human assessment submission, prompt edits, and import-store writes mark the exact affected project/article dirty state and do not recreate queue rows.
- [ ] Add project-article route delete coverage and agent-level `judgeStoreJudgment` dirty-state atomicity coverage before relying on those migrations; add their exact test commands to Quality Gates when those files exist.
- [ ] Add `scripts/rebuild2Cutover.test.ts` and include it in Quality Gates in the same clean-cut slice as the cutover command.
- [ ] Assert queue cutover clears existing `app.mart_refresh_queue` rows, drops/removes the queue path, and cannot recreate queue rows from any former caller.
- [ ] Assert `judgeStoreJudgment` stores the judgment and marks affected projects dirty atomically; if dirty-state marking fails, the judgment write cannot be silently committed as refreshed.
- [ ] Assert `judgmentJobSqliteOutboxImport` recovery at each cross-store crash point: after DuckDB insertion before dirty marking, after dirty marking before SQLite ACK, and after SQLite ACK before maintenance-lease completion.
- [ ] Assert incremental refresh worker wakes stop on wall-clock budget, leave durable dirty-state progress, and resume the next wake without reprocessing completed batches.
- [ ] Assert a claim with quarantined rows processes non-quarantined rows, does not publish ACK or advance `last_completed_refresh_token` past the quarantine barrier, releases or parks without failure when only quarantined rows remain, and resumes after explicit unquarantine/retry or bounded cleanup.
- [ ] Assert quarantine/barrier durable rows are keyed by project/article/dirty token, processed-past-barrier state is retained without reprocessing, redirty creates or reopens later dirty work, and pruning is blocked by any earlier unresolved quarantine.
- [ ] Assert processed dirty rows after a quarantine barrier are not reprocessed on every wake, are reopened if they become dirty again, and are only pruned once the barrier resolves and ACK advances.
- [ ] Assert `app.review_answer_dictionary` appends new answers without renumbering existing IDs across all remaining refresh paths and keeps active `review_article_filter_member` rows valid.
- [ ] Assert serving, detail, and filter-member rows always agree on the same active generation after incremental refresh, rebuild promotion, and cleanup lag.
- [ ] Assert large rebuild phases are idempotent by replaying a completed batch, expiring a lease, and resuming from the stored cursor.
- [ ] Assert an expired large rebuild worker cannot overwrite cursor, phase, refresh token, or `target_generation` after another worker has reclaimed the rebuild.
- [ ] Assert later large rebuild phases and operator/job progress stay tied to frozen scope rows when route or curated scope changes mid-rebuild.
- [ ] Assert archived-project delete-pending/tombstone state hides projects from normal API/UI reads while preserving enough identity for bounded cleanup to finish and final deletion to clear the tombstone.
- [ ] Assert archived-project cleanup runs in bounded batches and preserves global judgment facts still visible to non-archived projects.
- [ ] Assert archived-project deletion refreshes or detaches `mart.judgment_fact` ownership metadata and does not leave legacy `app.mart_refresh_queue` rows stuck forever during migration.
- [ ] Assert API and OLAP review filters and article review details return the same active-generation data before refresh, during dirty materialization, dirty refresh, and large rebuild work, after promotion, and after cleanup.
- [ ] Keep automated performance tests deterministic: synthetic 2M data should validate bounded dirty-batch work, DuckDB writer queue-wait observability, and memory/spill reporting, not exact timings; use coarse latency thresholds only in the manual 2M smoke.
- [ ] For shared review UI/API behavior, smoke both browser/web and desktop flows after the server-side gates pass.

## Quality Gates

- [ ] Quality Gates describe the active end state for each implementation slice; delete obsolete path tests and gates in the same clean-cut slice that deletes the obsolete paths, and add replacement test files before requiring their commands.
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
- [ ] `bun test src/server/utils/serverRole.test.ts`
- [ ] `bun test src/server/utils/backgroundServerStack.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectAccessGuard.test.ts`
- [ ] `bun test src/server/routes/ProjectsRoutes.test.ts`
- [ ] `bun test src/server/routes/judgmentsJobsRoutesApiReadModel.test.ts`
- [ ] `bun test src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts`
- [ ] `bun test src/server/routes/PromptsRoutes.test.ts`
- [ ] `bun test src/server/routes/SubprojectsRoutes.test.ts`
- [ ] `bun test src/server/routes/SubprojectsRoutes.rollback.test.ts`
- [ ] `bun test src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts`
- [ ] `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts`
- [ ] `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
- [ ] `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.test.ts`
- [ ] `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- [ ] `bun test src/server/routes/AdminInvestigateRoutes.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentJobLease.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteClaimRace.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentJobRepair.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentDispatchTelemetry.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentDispatchRuntime.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`
- [ ] `bun test src/server/utils/startBackgroundWork.test.ts`
- [ ] `bun test src/server/services/articleImportStoreService.test.ts`
- [ ] `bun test src/server/services/insertArticlesIntoProject.test.ts`
- [ ] `bun test src/server/services/judgmentJobDeleteService.test.ts`
- [ ] `bun test src/server/services/structuredFileImportService.test.ts`
- [ ] `bun test src/services/projectsService.test.ts`
- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] `bun test src/agent/judge/judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.test.ts`
- [ ] `bun test src/components/main/reviews/getReviewIndexingInProgressTitle.test.ts`
- [ ] `bunx vitest run src/components/main/reviews/reviewsProjectWarnings.vitest.tsx`
- [ ] `bun test scripts/runWithRuntimeProfile.test.ts`
- [ ] `bun test scripts/projectMartRefreshRecovery.test.ts`
- [ ] `bun test scripts/recoverJudgmentJobWithSystemSqlite.test.ts`
- [ ] Clean-cut cutover slice must add and run: `bun test scripts/rebuild2Cutover.test.ts`
- [ ] Quarantine migration slice must add and run CLI tests: `bun test scripts/quarantineProjectMartRefreshArticle.test.ts scripts/unquarantineProjectMartRefreshArticle.test.ts`
- [ ] `bun run db:mig`
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] `bun run desktop:build`
- [ ] Manual 2M synthetic run: ten dirty articles claim at most ten dirty article IDs, committed dirty-refresh row counts stay batch-bounded, review warnings/details p95 stays under 2s while maintenance runs, restart resumes from durable state, and promotion does not wait for cleanup.
- [ ] Manual browser and desktop reviews-page smoke: active data remains usable while dirty refresh or rebuild work is pending/running.
