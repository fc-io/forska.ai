# Rebuild 2 Plan

## Final Targets

- [ ] Support projects with 2M scoped articles.
- [ ] Make dirty-refresh append/upsert mart maintenance the normal path everywhere.
- [ ] Keep API, judging, imports, and UI reads responsive during maintenance.
- [ ] Accept eventual consistency; never block readers on catch-up or cleanup.
- [ ] Resume safely after process crash, restart, or lease expiry across dirty-state materialization, dirty-refresh, and large-rebuild work.
- [ ] Keep the design simple: bounded batches, durable cursors, small transactions.

## Remaining Principles

- [ ] Do not rebuild from scratch for normal judgment, human-review, or article churn.
- [ ] Treat marts as maintained indexes: append new facts and replace affected project/article rows.
- [ ] Large-rebuild work should be rare maintenance for repair, compaction, schema/rule changes, or explicit operator action.
- [ ] Every batch must commit independently and be retried idempotently.
- [ ] Current reads should use the best available mart state while background work catches up.
- [ ] Keep active serving generations internally consistent: dictionary IDs, filter members, serving rows, and details must agree for the active generation throughout large-rebuild work.
- [ ] Remove obsolete generic/full-refresh paths and mart tables in the same clean-cut slice that rewrites callers; do not keep compatibility shims or parallel maintenance paths.
- [ ] Do not preserve intermediate queue, dirty-state, rebuild-state, or mart-maintenance rows for backward compatibility; clear obsolete intermediate state and rederive replacement work during cutover when that makes the implementation simpler and safer.
- [ ] Cutover clearing must be explicit, worker-quiesced, fenced, and run through `db:duck:rebuild2-cutover` only: acquire the durable exclusive cutover fence, pause dirty-refresh, large-rebuild, quarantine, outbox, and lease drains; fence any pre-cutover obsolete queue drains/invocations; wait for active workers to stop or leases to expire, verify the deployed clean-cut slice removed obsolete write paths and obsolete callers/writers cannot recreate legacy rows, keep the durable fence so app/worker/pre-cutover invocations fail closed, clear obsolete queue/dirty/rebuild/quarantine/outbox/lease state, rederive replacement dirty-refresh or large-rebuild work from source-of-truth tables under the cutover owner token, release the fence, then resume workers.
- [ ] Never publish ACKs or advance completed tokens merely because obsolete intermediate state was cleared during cutover.
- [ ] Cutover must hold a durable exclusive fence read by maintenance workers, new dirty-refresh/large-rebuild/quarantine/outbox write paths, lease claim/completion paths, and any pre-cutover in-flight obsolete queue/refresh/outbox invocation: while the fence is active, workers and app write paths must not claim, ACK, complete, enqueue, quarantine, unquarantine, or clear dirty-refresh, large-rebuild, outbox, lease, or obsolete queue work; only the cutover owner token may recreate replacement dirty-state rows or large-rebuild requests, and obsolete invocations must fail closed instead of accepting rows.
- [ ] Do not clear legacy state until code paths that can recreate it are removed and verified unable to recreate legacy rows; post-cutover verification must repeat that proof as a regression check.

## Dirty-State Materialization And Callers

- [ ] Replace project-wide dirty-state creation that materializes scoped article IDs in JS with DB-side `INSERT ... SELECT` batches against the final versioned project scope source; materialization must record and validate the scope generation/high-water it read, and concurrent scope mutations must create later dirty tokens rather than mixing source states.
- [ ] Add durable project-wide dirty-state materialization state with source kind, target dirty token, cursor, inserted row count, source scope snapshot/high-water or fingerprint, status, and timestamps.
- [ ] Materialization state updates, cursor advancement, completion, failure marking, and token exposure must be fenced by materialization owner, lease, dirty token, source snapshot/high-water, and status; zero-row updates must be treated as lost lease and must not expose the dirty token, advance ACKs, or wake dirty-refresh workers.
- [ ] Rename dirty-refresh state columns and API fields from refresh-token terminology to dirty-token terminology, including `last_completed_refresh_token` to `last_completed_dirty_token`, without keeping parallel legacy field names.
- [ ] Ensure claim workers cannot see or ACK a project-wide dirty token until its article-state materialization completes.
- [ ] Project `last_completed_dirty_token`, completed-through markers, owner ACKs, and freshness status must not advance past the earliest dirty token whose project-wide article materialization is incomplete, failed, or unreconciled; later dirty work may be processed only if it cannot cause ACK/completion to skip that materialization barrier.
- [ ] Before marking a project-wide dirty-state materialization complete, reconcile the inserted article set against the recorded stable source snapshot/high-water or validated generation, including expected row count and source fingerprint where available; if reconciliation fails or the source snapshot is no longer valid, mark the materialization failed/unreconciled and keep the dirty token unclaimable until repaired or superseded.
- [ ] Project ACK/completed-token advancement must be computed as contiguous-token advancement: advance only to the highest dirty token for which every earlier token has completed materialization, has no unresolved quarantine barrier, and has all required dirty-refresh work processed or explicitly resolved; later processed-past-barrier rows must never allow skipping an earlier incomplete, failed, unreconciled, or quarantined token.
- [ ] Define project-wide dirty-state materialization scope stability: each target dirty token must read from one validated versioned project scope generation, and concurrent route/date-window/curated/import scope mutations must create a later dirty token instead of mixing source states under the current token.
- [ ] Update judgment-job unassessed count/article routes to treat incomplete project-wide dirty-state materialization and unresolved quarantine barriers as not-fully-fresh, returning explicit pending/stale status plus the best available bounded mart/read-model value; avoid unbounded raw source-of-truth scans in normal API paths.
- [ ] Move prompt changes, project create/edit/clone settings changes, route/import-store changes, project-article and subproject scope mutations, human assessment submissions, article import changes, archive/unarchive, backfill, purge, repair scripts, and judgment maintenance callers to dirty-state or guarded large-rebuild writes directly.
- [ ] Rework `scripts/repairOwnedProjectPrompts.ts` so repaired prompt/judgment rows create replacement dirty work through the new DB-side project-wide dirty-state materialization path, with durable cursor/status, instead of relying on a JS-collected project-id list and immediate project-level dirty marking.
- [ ] Replace generated dirty article `VALUES` and `IN (...)` lists with DuckDB temp or staging batch tables throughout dirty-refresh SQL.
- [ ] Make dirty-refresh batch transaction boundaries keep `mart.project_scope_article`, `mart.prompt_answer_fact`, `app.review_answer_dictionary`, `mart.review_article_rollup`, `mart.review_article_serving`, `mart.review_article_serving_detail`, and `mart.review_article_filter_member` internally consistent for each committed batch.
- [ ] Add a dirty-refresh worker wall-clock wake budget with durable resume after each committed dirty batch.
- [ ] Delete `refreshProject(projectId)`; replace any remaining structural repair entry point with `requestProjectLargeRebuild(projectId, reason)`, and keep no generic project refresh API.
- [ ] Use `db:duck:rebuild2-cutover` as the single authoritative cutover command sequence for fenced obsolete-state clearing and replacement dirty-state or large-rebuild request creation; do not duplicate weaker cutover sequences in schema migrations or helper scripts.
- [ ] Add an explicit `db:duck:rebuild2-cutover` package command in the same clean-cut slice that removes legacy state paths: acquire the durable cutover fence, pause workers, wait for active workers to stop or leases to expire, verify the deployed clean-cut slice removed obsolete legacy queue/refresh/rebuild/quarantine/outbox write paths and stale invocations fail closed, verify no legacy callers remain, clear obsolete queue/dirty/rebuild/quarantine/outbox/lease state, rederive replacement dirty-refresh or large-rebuild work under the cutover owner token, release the fence, then resume workers.
- [ ] During fenced `db:duck:rebuild2-cutover`, also delete stale obsolete `app.maintenance_work_lease` rows for obsolete review-index article refresh, project refresh, archived-project recovery work, and any large-rebuild lease whose backing rebuild state was cleared or rederived; if auditability is required, replace them only with explicit cutover audit/tombstone rows that cannot be interpreted as active, recoverable, ACKed, or completed work.
- [ ] During fenced `db:duck:rebuild2-cutover` only, delete stale obsolete `judgment_sqlite_outbox_import` rows in `app.maintenance_work_lease` and remove orphaned `app.judgment_job_sqlite_health_projection` rows without owner ACK only when they are proven orphaned, non-active, and not required to recover an unACKed SQLite outbox row; judgment-job deletion/start-clean cleanup must not clear obsolete outbox, lease, queue, dirty, rebuild, or quarantine state and may only operate on current non-obsolete job state.

## Queue Removal

- [ ] Replace all callers of `queueProjectRefresh`, `queueProjectRefreshes`, `queueProjectRefreshesByImportRouteIds`, `queueProjectRefreshesByPromptIds`, `queueJudgmentArticleRefresh`, `queueJudgmentArticleRefreshes`, `queueJudgmentArticleRefreshesByJudgmentIds`, `queueJudgmentArticleRefreshesByPromptIds`, and `queueImportedArticleRefreshes` with dirty-state or guarded large-rebuild writes directly, then delete the old queue-named exports in the same slice.
- [ ] Update `src/agent/judge/judgeStoreJudgment.ts` / `judgeStoreJudgment` so dirty-state marking is atomic with judgment persistence and stored judgments cannot commit without corresponding dirty-state work.
- [ ] Make `judgmentJobSqliteOutboxImport` crash-safe and idempotent across DuckDB judgment insertion, dirty-state marking, and SQLite outbox ACK/claim completion so imported judgments cannot become visible without corresponding dirty work, and outbox rows cannot be cleared before dirty work is durable.
- [ ] Separate judgment import ACK from dirty-refresh completion: SQLite judgment outbox rows may be ACKed only after DuckDB judgment insertion and the corresponding dirty-state/materialization request are durable and idempotently recoverable; project dirty-refresh ACK/completed-token advancement remains blocked by unresolved quarantine, and SQLite outbox ACK must not wait for mart maintenance unless the outbox row explicitly represents serving mart-maintenance completion rather than judgment-import durability.
- [ ] The SQLite outbox ACK boundary is the committed DuckDB transaction containing the judgment upsert, idempotency key/outbox import marker, and durable dirty-state or project-wide materialization request; SQLite ACK must occur only after that boundary is durable, and recovery must use the idempotency key/import marker to distinguish already-imported judgments from unprocessed outbox rows without requiring cross-store transactionality.
- [ ] Define and test `judgmentJobSqliteOutboxImport` recovery for crashes after DuckDB insertion before dirty marking, after dirty marking before SQLite ACK, and after SQLite ACK before maintenance-lease completion; maintenance-lease completion after SQLite ACK must be idempotent bookkeeping only and must not publish another ACK or imply mart completion, and the flow must not require a literal cross-store transaction.
- [ ] Move remaining import-store, archive, unarchive, backfill, purge, and repair-script callers away from `app.mart_refresh_queue`.
- [ ] Clear all remaining legacy `app.mart_refresh_queue` rows during cutover instead of draining or preserving them, with the cutover fence held and legacy queue writes already impossible or fail-closed.
- [ ] Do not rely on the existing partial `0054_clearProjectMartRefreshQueueProjectTasks.sql` migration for rebuild2 cutover; `db:duck:rebuild2-cutover` must clear all remaining `app.mart_refresh_queue` rows, cover non-project scopes such as `judgment_article`, verify the durable cutover completion marker, and verify no rows remain before the schema-only table-drop migration is allowed.
- [ ] Drop the already-cleared `app.mart_refresh_queue` table through a schema-only migration after fenced `db:duck:rebuild2-cutover`; the migration may only perform DDL and must not clear rows or perform cutover-state validation; delete queue schema repair code, auto-drain code including `src/server/utils/martRefreshDrainHeartbeat.ts` and its `startBackgroundWork` wiring, queue APIs, queue CLI/package scripts including `db:duck:recover-archived-refresh-queue`, queue scripts/tests including `scripts/recoverArchivedProjectRefreshQueue.ts` and `scripts/recoverArchivedProjectRefreshQueue.test.ts`, and legacy queue pruning code.
- [ ] Remove queue exports/imports and the table in the same implementation slice so no live caller can recreate queue rows after cutover; do not leave no-op wrappers.
- [ ] The clean-cut deletion slice must remove archived refresh queue recovery and drain heartbeat paths, tests, and quality gates together, replacing them with dirty-refresh wake/lease and bounded tombstone cleanup gates.

## Quarantine And ACK Semantics

- [ ] Define and implement the quarantine ACK barrier: quarantined article rows remain durable with quarantine metadata, and project `last_completed_dirty_token`, owner ACKs, SQLite outbox/import ACKs that explicitly represent mart-maintenance completion, and any completed-through-token marker must not advance past the earliest unresolved quarantined dirty token; individual worker claims may finish, release, or park as `blocked_by_quarantine` after persisting processed-past-barrier state, but that status must not be interpreted as project ACK/completion.
- [ ] During fenced `db:duck:rebuild2-cutover` only, clear obsolete article-only quarantine rows, rederive required current quarantine/dirty-refresh work from source-of-truth tables under the cutover owner token, verify the durable cutover completion marker, and verify no obsolete rows remain; the later schema-only migration may only perform DDL/rename from `app.project_mart_refresh_article_quarantine` to `app.project_mart_dirty_refresh_article_quarantine`, and must not delete, rewrite, backfill, migrate, or validate obsolete rows.
- [ ] Define the durable quarantine/barrier state model before implementation: unresolved quarantine rows keyed by project, article, and dirty token; processed-past-barrier rows must retain processed token/status; redirtied rows must record the reopened token; pruning must prove no earlier unresolved quarantine remains and the project ACK has advanced past the barrier.
- [ ] Continue processing non-quarantined dirty rows while keeping project completion and ACK behind unresolved quarantined rows.
- [ ] Record processed-but-not-ACKable dirty article rows past a quarantine barrier so later rows do not reprocess forever while ACK remains blocked by an earlier quarantined token.
- [ ] If a processed-but-not-ACKable article becomes dirty again before the barrier resolves, retain the processed-past-barrier record for the earlier token and create or reopen later dirty-refresh work for the new token; do not mutate the earlier processed token in a way that lets ACK advancement skip the later change.
- [ ] Prune processed dirty article rows only after every earlier quarantined token is resolved and the project ACK has advanced past the barrier.
- [ ] When all remaining claim rows are quarantined, persist the claim as released or parked `blocked_by_quarantine` without advancing project ACK/completed-token state, instead of failing for no progress or recursively reclaiming forever.
- [ ] Add explicit unquarantine/retry semantics before a quarantined row can be resolved and then included in ACK advancement or pruning; bounded cleanup may only prune already-resolved rows after the project ACK has advanced past the barrier.
- [ ] Rename quarantine CLIs to `db:duck:quarantine-dirty-refresh-article` and `db:duck:unquarantine-dirty-refresh-article`, delete the old refresh-named package scripts in the same slice, and add CLI coverage proving they preserve the ACK barrier, report impacted projects, and only release blocked state through the explicit unquarantine/retry path.

## Large-Rebuild Hardening

- [ ] Guard every large-rebuild state transition by worker, lease, phase, token, and target generation, including cursor updates, phase advancement, active-generation promotion, cleanup eligibility, and completed/ACK markers; zero-row updates must be treated as lost lease with no ACK, promotion, cleanup, or phase advancement.
- [ ] Rename large-rebuild state fields from generic refresh-token terminology to rebuild-token terminology; old names must only appear in schema migration filenames, schema rename SQL, and explicit rename assertions.
- [ ] Make every large-rebuild phase strictly delete and insert only the current batch; replace remaining whole-project or phase-setup resets with generation-scoped, batch-bounded deletes/inserts, except one-time initialization of an inactive target generation before any serving references exist and guarded by generation, phase, lease, and rebuild token.
- [ ] Freeze large-rebuild scope membership under the rebuild token/generation before downstream phases read it; later route, curated, date-window, import, archive, or project-scope mutations must create later dirty-refresh or large-rebuild work and must not mutate the frozen scope used by an in-progress rebuild.
- [ ] Record the rebuild source dirty-token/high-water with the frozen scope; promotion must be fenced by rebuild token, lease owner, phase, and target generation, and must either replay or carry forward all later dirty-refresh work into the target generation before promotion or durably mark that later work as pending against the promoted generation before reporting the project fully fresh.
- [ ] For each project/rebuild kind, promotion must also be fenced by project-level rebuild ordering: only the current non-superseded rebuild token may promote; if a newer rebuild request/generation exists, an older rebuild must be marked superseded or repair-only and must not promote, mark completion, advance ACKs, or make cleanup eligible.
- [ ] Retire or replace the old full-refresh dictionary rebuild path that deletes and renumbers `app.review_answer_dictionary` while active-generation filter rows may reference existing IDs.
- [ ] Keep large-rebuild work available for structural changes and repair only, not normal dirty-maintenance work.
- [ ] Replace `db:duck:rebuild-marts`, `db:duck:backfill-review-serving-v3`, `db:duck:refresh-project-once`, `db:duck:run-large-rebuild-cycle`, and `db:duck:run-large-rebuild-cycles` with final explicit operator commands: `db:duck:request-project-large-rebuild`, `db:duck:request-review-serving-large-rebuild`, `db:duck:run-large-rebuild-worker-once`, and `db:duck:run-large-rebuild-worker-cycles`; remove active docs/package references found by an automated obsolete-command-reference test, including `AGENTS.md` and current README/docs references to obsolete command names except historical migration notes.
- [ ] Replace `db:duck:inspect-project-refresh-risk` with `db:duck:inspect-dirty-refresh-risk` and replace `db:duck:recover-project-refresh-claims` with `db:duck:recover-dirty-refresh-claims`; the final commands must understand durable dirty-state materialization state, dirty-token quarantine barriers, project date-window/curated scope, and large-rebuild leases, and must not keep project-refresh claim terminology.
- [ ] Delete `db:duck:repair-project-refresh-ledger`; replace `db:duck:repair-judgment-fact` with `db:duck:request-judgment-fact-repair`, which schedules current structural repair or large-rebuild work instead of hand-written table surgery, and no repair command may drop, recreate, truncate, or clear obsolete queue/dirty/rebuild/quarantine/outbox/lease state outside explicit fenced `db:duck:rebuild2-cutover`.
- [ ] Rename queue-named large-rebuild APIs after queue cutover: `queueLargeRebuild`, `queueProjectLargeRebuild`, `queueProjectLargeRebuilds`, `queueLargeRebuildsForDirtyStates`, and `queueProjectLargeRebuildForDirtyArticles` to `requestLargeRebuild`, `requestProjectLargeRebuild`, `requestProjectLargeRebuilds`, `requestLargeRebuildsForDirtyStates`, and `requestProjectLargeRebuildForDirtyArticles` so no non-queue path keeps queue terminology.
- [ ] Rename `getDuckdbMartRefreshService` and its tests to `getDuckdbMartMaintenanceService` after queue deletion, so the long-term service name covers dirty-refresh, large-rebuild, and bounded cleanup without preserving legacy refresh-queue terminology.
- [ ] Add a rebuild2 migration audit/test for qualified DuckDB `DROP INDEX` migrations, covering duplicate or intentionally repeated index-drop migrations such as `0056`, `0057`, and `0058`, and document whether they must remain separate for already-applied migration history.

## Archived Project Cleanup

- [ ] Move archived-project delete off synchronous full purge and table rebuilds; use bounded cleanup behind active dirty-refresh, large-rebuild, and judging work.
- [ ] Delete `scripts/purgeArchivedProjectMarts.ts`, `scripts/reproArchivedProjectServingDelete.ts`, their tests, and the `db:duck:purge-archived-marts` package script; replace them with `db:duck:run-archived-project-bounded-cleanup` and bounded tombstone cleanup tests so archived cleanup does not keep stale hard-coded mart table allowlists or serving-delete remediation paths.
- [ ] Rework `/api/projects/delete-archived` in `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts` so an archived delete request creates tombstone/delete-pending cleanup work instead of synchronously purging marts and rebuilding app tables in the request path.
- [ ] Define archived-project deletion lifecycle explicitly: mark projects as delete-pending/tombstoned, hide them from normal API/UI reads, keep enough project identity for bounded cleanup, then delete source rows only after cleanup completes.
- [ ] Store tombstoned project cleanup identity in a table that bounded cleanup workers can scan without relying on visible `app.project` rows.
- [ ] Tombstone cleanup must not delete final project identity/source rows until all referencing dirty-state materialization rows, dirty-refresh rows, unresolved quarantine barriers, large-rebuild requests/leases, bounded cleanup work, and judgment outbox/import health projections are completed through their normal current-state lifecycle, cancelled under the fenced `db:duck:rebuild2-cutover` owner token when they are obsolete cutover state, or converted by cleanup into explicit non-active tombstone records that cannot advance ACKs, completed tokens, owner ACKs, or outbox ACKs; archived cleanup must not clear obsolete queue/dirty/rebuild/quarantine/outbox/lease state outside fenced `db:duck:rebuild2-cutover`.
- [ ] Make global `mart.judgment_fact` project-independent for archived cleanup: treat judgment/config identity as the fact identity, move project/snapshot display metadata to project-scoped serving/detail rows, and clear only the deleted project's project-scoped references while preserving facts still visible to non-archived projects.
- [ ] Preserve global/shared judgment facts after archived project deletion in all cleanup paths.
- [ ] Clear all legacy `app.mart_refresh_queue` rows for archived or deleted projects, including remaining `judgment_article` rows, as part of the fenced queue cutover.
- [ ] Include `app.project_review_serving_generation` and deleted-project serving/detail/filter-member rows in bounded archived cleanup while preserving shared/global judgment facts; treat `app.review_answer_dictionary` as shared stable dictionary metadata, do not renumber IDs, and prune dictionary rows only in a separate bounded cleanup step after proving no active or retained generation references them.
- [ ] Dictionary cleanup must also prove no in-progress target generation, retained generation, active serving row, detail row, or filter-member row references a dictionary ID before pruning; no dirty-refresh, large-rebuild, repair, or cleanup path may delete and renumber dictionary IDs.
- [ ] Old-generation cleanup deletes must be generation-scoped, lease-fenced, batch-bounded, and must recheck at delete time that the generation is not active, not an in-progress target generation, not retained, and not referenced by serving/detail/filter-member/dictionary rows; a zero-row or failed eligibility update must stop cleanup without ACK/completion side effects.

## Observability And UI

- [ ] Keep detailed rows/sec, RSS, temp spill, and DuckDB writer queue-wait diagnostics API/admin-only; the review-page banner should only show user-actionable status, counts, and last-progress timestamps.
- [ ] Add comparable committed row, DuckDB writer queue-wait, RSS, temp spill, and budget diagnostics for dirty-refresh wakes using the durable wake budget.
- [ ] Keep review warnings API and review indexing copy in sync with new dirty/materialization/quarantine states without exposing admin-only diagnostics in the user banner.
- [ ] Smoke browser/web and desktop review flows after server-side gates pass.

## Success Criteria

- [ ] Ten dirty articles in a 2M-article project claim at most those ten article IDs for dirty-refresh, do not materialize project scope article IDs in JS, and do not run project-wide downstream deletes for the claim.
- [ ] Normal judgment churn is `O(dirty articles)`, not `O(project scope)`: committed dirty-refresh row counts and query inputs scale with the dirty batch size, excluding bounded dictionary/filter maintenance for touched rows.
- [ ] A structural 2M-article large-rebuild can run for hours without blocking normal reads or writes: review reads use the active generation, writes can mark later dirty-refresh or large-rebuild work, and maintenance-worker waits are observable rather than hidden in API handlers.
- [ ] Restarting mid-batch replays safely with no duplicate committed mart rows; restarting mid-phase resumes from the last committed cursor and stale workers with expired leases cannot advance state.
- [ ] Promotion is a short active-generation swap transaction, completes before old-generation cleanup starts, and does not wait for old-generation cleanup.
- [ ] Non-barrier cleanup can lag without blocking ACKs or UI reads; unresolved quarantine barriers still block ACK advancement, and lag is visible as bounded cleanup work rather than reader fallback to obsolete tables.
- [ ] Quarantined dirty articles are visible and durable, but project ACKs do not advance past unresolved quarantined dirty tokens.
- [ ] Crashing during project-wide dirty-state materialization resumes safely and never lets workers process or ACK a partial dirty set.
- [ ] Temp spill, RSS, and DuckDB writer queue-wait stay observable during the run.
- [ ] Filtered review reads keep returning correct labels/results while a large-rebuild job is in progress.

## Remaining Test Strategy

- [ ] Add or update tests with each remaining implementation slice before relying on manual 2M verification.
- [ ] Prefer DB-backed service tests over mocked SQL for mart correctness, using small fixtures that prove row-level invariants.
- [ ] Assert project-wide dirty-state writes for prompt changes, route/import-store changes, backfill, repair, and project-level marks use DB-side `INSERT ... SELECT` batches with project date-window constraints against the validated final versioned project scope source, maintain durable materialization cursor/status, do not materialize scoped article IDs in JS, and do not expose claimable tokens until materialization completes.
- [ ] Assert a project-wide materialization token reads one validated versioned project scope generation, and a mid-materialization scope/date-window/curated/import mutation creates later dirty-refresh work instead of mixing states under the current token.
- [ ] Assert project-wide dirty-state materialization owner/lease fencing prevents stale workers from advancing cursors, marking completion/failure, exposing tokens, waking dirty-refresh workers, or advancing ACK/completed-token state after lease loss.
- [ ] Assert project-wide dirty-state materialization recovers idempotently after crashes before the state row is created, after the state row before any article insert, mid-batch, after article inserts before status completion, and after status completion before worker wake; partial materializations must remain unclaimable and must not advance ACK/completed-token state.
- [ ] Assert cutover acquires the durable fence, pauses workers, waits for active workers to stop or leases to expire, blocks worker claims, ACKs, completions, quarantine changes, and outbox clearing, verifies the deployed clean-cut slice removed legacy queue/quarantine/outbox write paths, makes stale legacy writes fail closed, verifies no legacy callers remain before clearing, clears obsolete queue/dirty/rebuild/quarantine/outbox/lease state and deletes or tombstones stale maintenance leases without ACK/completion semantics, rederives replacement dirty-refresh or large-rebuild work from source-of-truth tables under the cutover owner token, repeats the no-legacy-caller/no-obsolete-row-recreation proof after clearing and after workers resume, releases the fence, resumes workers, and does not publish ACKs from clearing alone.
- [ ] Assert former `queueProjectRefresh` and `queueJudgmentArticleRefresh` triggers for judgment changes, prompt changes, route/import-store changes, archive, unarchive, backfill, purge, and repair-script work write dirty-state or large-rebuild work directly and no longer depend on legacy `app.mart_refresh_queue` behavior.
- [ ] Assert project create/edit/clone, project-article deletes, subproject creation, human assessment submission, prompt edits, and import-store writes mark the exact affected project/article dirty state and do not recreate queue rows.
- [ ] Add project-article route delete coverage and agent-level `judgeStoreJudgment` dirty-state atomicity coverage before shipping the clean-cut slices; keep their exact test commands in Quality Gates.
- [ ] Add `scripts/rebuild2Cutover.test.ts` and include it in Quality Gates in the same clean-cut slice as the cutover command.
- [ ] Assert queue cutover clears existing `app.mart_refresh_queue` rows, removes the queue table/path, and cannot recreate queue rows from any former caller.
- [ ] Assert `judgeStoreJudgment` stores the judgment and marks affected projects dirty atomically; if dirty-state marking fails, the judgment write cannot be silently committed as dirty-work durable or ACK-safe, and no queue-named wrapper remains around the dirty-state write.
- [ ] Assert `judgmentJobSqliteOutboxImport` recovery at each cross-store crash point: after DuckDB insertion before dirty marking, after dirty marking before SQLite ACK, and after SQLite ACK before maintenance-lease completion; post-ACK lease completion must be idempotent bookkeeping only, not a second ACK or mart-completion signal.
- [ ] Assert SQLite judgment outbox import ACK is allowed only after judgment persistence plus durable dirty-state/materialization work, must not wait for dirty-refresh/mart maintenance for normal judgment-import rows, and remains separate from project dirty-refresh ACK, which is blocked by unresolved quarantine; recovery must not duplicate judgments or lose dirty work when quarantine blocks mart completion.
- [ ] Assert dirty-refresh worker wakes stop on wall-clock budget, leave durable dirty-state progress, and resume the next wake without reprocessing completed batches.
- [ ] Assert a claim with quarantined rows processes non-quarantined rows, does not publish ACK or advance `last_completed_dirty_token` past the quarantine barrier, releases or parks as `blocked_by_quarantine` without failure when only quarantined rows remain, resumes after explicit unquarantine/retry, and lets bounded cleanup prune only already-resolved rows after the project ACK has advanced past the barrier.
- [ ] Assert quarantine/barrier durable rows are keyed by project/article/dirty token, processed-past-barrier state is retained without reprocessing, redirty creates or reopens later-token dirty work without erasing the earlier processed token, and pruning is blocked by any earlier unresolved quarantine.
- [ ] Assert processed dirty rows after a quarantine barrier are not reprocessed on every wake, are reopened if they become dirty again, and are only pruned once the barrier resolves and ACK advances.
- [ ] Assert `app.review_answer_dictionary` appends new answers without renumbering existing IDs across all dirty-refresh, large-rebuild, and bounded cleanup paths and keeps active `review_article_filter_member` rows valid.
- [ ] Assert serving, detail, and filter-member rows always agree on the same active generation after dirty-refresh, large-rebuild promotion, and cleanup lag.
- [ ] Assert large-rebuild phases are idempotent by replaying a completed batch, expiring a lease, and resuming from the stored cursor.
- [ ] Assert an expired large-rebuild worker cannot overwrite cursor, phase, rebuild token, or `target_generation` after another worker has reclaimed the rebuild.
- [ ] Assert an expired large-rebuild worker cannot promote a target generation, mark rebuild completion, advance ACK/completed state, or make old-generation cleanup eligible after another worker has reclaimed the rebuild.
- [ ] Assert an older superseded large-rebuild token cannot promote, mark completion, advance ACK/completed state, or make cleanup eligible after a newer rebuild request/generation exists for the same project/rebuild kind.
- [ ] Assert old-generation cleanup rechecks generation references at delete time and stops without ACK/completion side effects when the generation is active, target, retained, or still referenced by serving/detail/filter-member/dictionary rows.
- [ ] Assert later large-rebuild phases and operator/job progress stay tied to frozen scope rows when route or curated scope changes mid-rebuild.
- [ ] Assert archived-project delete-pending/tombstone state hides projects from normal API/UI reads while preserving enough identity for bounded cleanup to finish and final deletion to clear the tombstone.
- [ ] Assert archived-project cleanup runs in bounded batches and preserves global judgment facts still visible to non-archived projects.
- [ ] Assert archived-project deletion keeps project-independent `mart.judgment_fact` rows intact, removes only deleted-project project-scoped metadata, and does not leave legacy `app.mart_refresh_queue` rows stuck forever during fenced cutover.
- [ ] Assert archived-project final deletion is blocked while unresolved dirty-state materialization rows, dirty-refresh rows, quarantine barriers, large-rebuild requests/leases, bounded cleanup work, or judgment outbox/import health projections still reference the project, and that cleanup resolves, completes, cancels under fenced cutover, or tombstones those references without publishing ACK/completion from deletion alone.
- [ ] Assert API and OLAP review filters and article review details return the same active-generation data before dirty-state materialization or dirty-refresh work, during dirty-state materialization, dirty-refresh, and large-rebuild work, after promotion, and after cleanup.
- [ ] Assert `package.json` exposes final rebuild2 package commands, omits obsolete command names, keeps no no-op compatibility wrappers, and makes `db:duck:rebuild2-cutover` the only command allowed to clear obsolete queue/dirty/rebuild/quarantine/outbox/lease state.
- [ ] Keep automated performance tests deterministic: synthetic 2M data should validate bounded dirty-batch work, DuckDB writer queue-wait observability, and memory/spill reporting, not exact timings; use coarse latency thresholds only in the manual 2M smoke.
- [ ] For shared review UI/API behavior, smoke both browser/web and desktop flows after the server-side gates pass.

## Quality Gates

Quality Gates describe the final active end state after all clean-cut deletions and renames in this plan; obsolete path tests and transitional rename gates must not remain in this list.
- [ ] `bun test src/server/workers/projectMartDirtyRefreshWorker.test.ts`
- [ ] `bun test src/server/services/projectMartDirtyRefreshStateService.test.ts`
- [ ] `bun test src/server/services/projectMartDirtyMaterializationService.test.ts`
- [ ] `bun test src/server/services/projectMartDirtyRefreshQuarantineBarrier.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildStateService.test.ts`
- [ ] `bun test src/server/services/getDuckdbMartMaintenanceService.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildRunner.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildWorkerService.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildFrozenScope.test.ts`
- [ ] `bun test src/server/services/projectMartLargeRebuildLeaseFencing.test.ts`
- [ ] `bun test src/server/services/reviewAnswerDictionaryStability.test.ts`
- [ ] `bun test src/db/migrateDuckdb.test.ts`
- [ ] `bun test src/server/utils/projectMartLargeRebuildHeartbeat.test.ts`
- [ ] `bun test src/server/utils/projectMartDirtyRefreshWorkerHeartbeat.test.ts`
- [ ] `bun test src/server/utils/serverRole.test.ts`
- [ ] `bun test src/server/utils/backgroundServerStack.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarningsTrigger.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectAccessGuard.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleDelete.test.ts`
- [ ] `bun test src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.test.ts`
- [ ] `bun test src/server/routes/ProjectsRoutes.test.ts`
- [ ] `bun test src/server/routes/judgmentsJobsRoutesApiReadModel.test.ts`
- [ ] `bun test src/server/routes/judgmentsJobsRoutesDirtyMaterializationFreshness.test.ts`
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
- [ ] `bun test src/server/cron/judgmentsJobs/judgmentsJobsMarkDirtyWork.test.ts`
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
- [ ] `bun test src/server/services/archivedProjectCleanupService.test.ts`
- [ ] `bun test src/server/services/structuredFileImportService.test.ts`
- [ ] `bun test src/services/projectsService.test.ts`
- [ ] `bun test src/services/olap/duckdbOlap.test.ts`
- [ ] `bun test src/agent/judge/judgeStoreJudgment/judgeStoreJudgmentDirtyStateAtomicity.test.ts`
- [ ] `bun test src/agent/judge/judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.test.ts`
- [ ] `bun test src/components/main/reviews/getReviewIndexingInProgressTitle.test.ts`
- [ ] `bunx vitest run src/components/main/reviews/reviewsProjectWarnings.vitest.tsx`
- [ ] `bun test scripts/runWithRuntimeProfile.test.ts`
- [ ] `bun test scripts/projectMartDirtyRefreshRecovery.test.ts`
- [ ] `bun test scripts/inspectDirtyRefreshRisk.test.ts`
- [ ] `bun test scripts/recoverDirtyRefreshClaims.test.ts`
- [ ] `bun test scripts/requestProjectLargeRebuild.test.ts`
- [ ] `bun test scripts/repairOwnedProjectPrompts.test.ts`
- [ ] `bun test scripts/requestJudgmentFactRepair.test.ts`
- [ ] `bun test scripts/requestReviewServingLargeRebuild.test.ts`
- [ ] `bun test scripts/runLargeRebuildWorkerOnce.test.ts`
- [ ] `bun test scripts/runLargeRebuildWorkerCycles.test.ts`
- [ ] `bun test scripts/runArchivedProjectBoundedCleanup.test.ts`
- [ ] `bun test scripts/recoverJudgmentJobWithSystemSqlite.test.ts`
- [ ] `bun test scripts/rebuild2Cutover.test.ts`
- [ ] `bun test scripts/rebuild2ObsoleteCommandReferences.test.ts`
- [ ] `bun test scripts/rebuild2PackageCommands.test.ts`
- [ ] `bun test scripts/quarantineDirtyRefreshArticle.test.ts scripts/unquarantineDirtyRefreshArticle.test.ts`
- [ ] `bun run db:mig` for schema-only migrations; obsolete state clearing must run only through `db:duck:rebuild2-cutover`.
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] `bun run desktop:build`
- [ ] Manual 2M synthetic run: ten dirty articles claim at most ten dirty article IDs, committed dirty-refresh row counts stay batch-bounded, review warnings/details p95 stays under 2s while maintenance runs, restart resumes from durable state, and promotion does not wait for cleanup.
- [ ] Manual browser and desktop reviews-page smoke: active data remains usable while dirty-refresh or large-rebuild work is pending/running.
