# OOM Errors

Record every out-of-memory issue and fix here.

Entry format:

## YYYY-MM-DD - Area

- Error: Short log excerpt.
- Context: Affected job, query, route, command, or runtime path.
- Cause: Short explanation of why memory was exhausted.
- Fix: Short explanation of the code, query, config, or operational change.
- Verification: Command, test, or runtime check used to verify the fix.

## 2026-07-06 - Summary Dirty Source Scope

- Error: Ordinary summary dirty claims could scan all `mart.project_scope_article` rows for a project when no rebuild chunk range was present.
- Context: `projectReviewServingSummaries` dirty background patch wake for review-serving summary counts/facets.
- Cause: The dirty path called the full-rebuild source helper without passing claimed article ids, so the dirty article CTE fell back to project-wide scope selection.
- Fix: Dirty summary recompute now uses the claimed-article source helper and has a regression test asserting the source SQL uses a bounded `VALUES` article filter.
- Verification: `bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts`.

## 2026-07-06 - Retired Review-Serving Table Drain

- Error: Historical rows in retired `mart.review_*_patch_v4` tables and `mart.review_article_summary_contribution_v4` could keep bloating DuckDB snapshots/backups after the serving cutover.
- Context: Review-serving retention cleanup after legacy patch and summary contribution runtime paths were removed.
- Cause: The cleanup cursor cycled only through active serving table specs, so upgraded databases with already-populated retired tables never selected those tables for deletion.
- Fix: Retention cleanup now includes a separate bounded per-project drain for retired patch tables and the summary contribution ledger while keeping active serving cleanup snapshot-protected.
- Verification: `bun test src/server/reviewServing/reviewServingRetentionService.test.ts`; live current-DB progress gate.

## 2026-07-05 - Large Snapshot Pre-Copy Checkpoint OOM

- Error: `Failed to create checkpoint: Out of Memory Error: could not allocate block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` while running `db:query:snapshot` against the 78GB primary runtime DB.
- Context: Current-DB live progress verification after adding a pre-copy checkpoint to avoid copied DDL WAL replay failures for small snapshots.
- Cause: The checkpoint is safe for small script/test DBs but can exceed the constrained maintenance profile on large runtime DBs.
- Fix: Snapshot creation only checkpoints small DB files before copying; large DB snapshots keep the checkpoint-free DB+WAL copy path.
- Verification: `bun test src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts src/server/utils/duckdbScriptAccess.test.ts`; current-DB live progress gate.

## 2026-07-05 - Snapshot Fallback Checkpoint OOM

- Error: `Failed to create checkpoint: Out of Memory Error: could not allocate block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` while running `db:query:snapshot` against the runtime primary DB.
- Context: Current-DB live progress verification after the snapshot fallback switched away from `COPY FROM DATABASE`.
- Cause: The FK-safe fallback reintroduced a forced `CHECKPOINT`, which can exceed the constrained maintenance profile memory cap.
- Fix: Snapshot fallback now copies the database file and WAL under the append barrier, avoiding both FK copy-order failures and live checkpoint allocation.
- Verification: `bun test src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts src/server/utils/duckdbScriptAccess.test.ts`; current-DB `db:query:snapshot`.

## 2026-07-05 - Legacy Review-Serving Patch Retention

- Error: Large legacy V4 patch tables kept being scanned by startup integrity probes after the dirty-patch cutover.
- Context: `review_llm_status_patch_v4` and sibling legacy patch tables during DuckDB startup preflight and backup/snapshot work.
- Cause: Retention cleanup removed the old patch cleanup specs entirely, leaving existing patch rows to persist forever.
- Fix: Retention cleanup now drains all legacy V4 patch tables in bounded per-project batches while direct serving tables continue normal snapshot-protected cleanup.
- Verification: `bun test src/server/reviewServing/reviewServingRetentionService.test.ts`.

## 2026-07-04 - Default Review-Serving Rebuild Batch Cap

- Error: Turning serial multi-chunk review-serving rebuild batching on by default would be unsafe without a default memory cap.
- Context: Maintenance heartbeat defaults for `reviewServing.projector.worker` controlled Phase 6 batching.
- Cause: The previous guardrail existed only when an operator configured both batch size and RSS cap, so a default-on batch size could otherwise run uncapped.
- Fix: Maintenance env defaults now use `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE=2` with an auto system-memory-derived `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES`, while explicit env overrides can still force size 1 or cap 0/off.
- Verification: `bun test src/server/utils/env.test.ts src/server/utils/reviewServingProjectorWorkerHeartbeat.test.ts src/server/workers/reviewServingProjectorWorker.test.ts`.

## 2026-07-04 - Review-Serving Rebuild Batch RSS Guardrail

- Error: Opt-in multi-chunk review-serving rebuild batches could keep claiming additional chunks even when process RSS was already high.
- Context: `reviewServing.projector.worker` when `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE` is raised above 1.
- Cause: The batch loop honored only the configured chunk count and had no process-memory admission check before draining multiple chunks in one wake.
- Fix: Added `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES`; when set and current RSS reaches the cap, the worker limits the effective batch size to one chunk while preserving the serialized writer lane.
- Verification: `bun test src/server/utils/env.test.ts src/server/utils/reviewServingProjectorWorkerHeartbeat.test.ts src/server/workers/reviewServingProjectorWorker.test.ts`.

## 2026-07-04 - Summary Contribution Finalization Publication

- Error: Review-serving summary finalization could still recreate unbounded DuckDB aggregation over `review_article_summary_contribution_rebuild_partial_v4` after count/facet accumulator batching.
- Context: Request-associated chunked full-summary rebuild finalization for large current-DB requests.
- Cause: Contribution partial publication scanned and grouped all completed summary contribution partial rows for a request/snapshot in one transaction, and stale count/facet accumulator sentinel rows were not scoped to the active chunk manifest set.
- Fix: Contribution partials now publish and delete in the same bounded chunk batches as count/facet accumulator reduction, and accumulator chunk IDs are scoped to the active summary chunk manifest set so changed chunk sets cannot reuse old sentinel totals.
- Verification: `bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts`; live current-DB progress gate.

## 2026-07-04 - Snapshot Checkpoint Regression

- Error: `Failed to create checkpoint: Out of Memory Error: could not allocate block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` when creating DuckDB Studio/current-DB snapshots under the low-memory maintenance owner.
- Context: `createDuckdbSnapshot` copied snapshot files after forcing `CHECKPOINT` despite the append barrier and documented checkpoint-free snapshot path.
- Cause: A checkpoint call was reintroduced in `copyDuckdbSnapshot`, making read-only snapshot creation allocate checkpoint memory in constrained runtimes.
- Fix: Snapshot creation now copies the database file under the append barrier without forcing a checkpoint.
- Verification: `bun test src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts src/server/utils/duckdbScriptAccess.test.ts`; live current-DB progress gate.

## 2026-07-04 - Summary Partial Finalization Reduction

- Error: Live primary `dev:server` maintenance owner reached about 14.6GB RSS, then exited with Bun `panic: A C++ exception occurred` while the review-serving current-DB progress gate was advancing project `d03fe24a-cfcf-41ed-b09f-7b554a393d80`.
- Context: Request-associated chunked full-summary rebuilds and completed-request finalization over `mart.review_article_summary_rebuild_partial_v4` under the bounded maintenance profile.
- Cause: Summary partial finalization reduced all request partial rows for a snapshot with request-wide `INSERT ... GROUP BY` statements in one transaction, so large current-DB requests with tens of thousands of summary chunks could still create an unbounded native aggregation even though chunk projection was bounded.
- Fix: Summary finalization now first reduces partial rows into per-serving-key accumulator rows in bounded `chunk_id` batches, atomically deleting each reduced batch, then writes final count/facet serving rows from the bounded accumulator only.
- Verification: `bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts`.

## 2026-07-04 - Low-Memory Migration Checkpoint OOM

- Error: `Failed to create checkpoint: Out of Memory Error: could not allocate block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` after `bun run db:mig` applied `0112_reviewServingSummaryRebuildPartial.sql`.
- Context: Primary DuckDB migration command under the 6400MiB maintenance profile.
- Cause: `migrateDuckdb` forced an explicit post-migration checkpoint after any applied migration, even under low-memory maintenance limits where checkpoint work can exceed the cap.
- Fix: Low-memory migration runs now skip the explicit post-migration checkpoint and rely on committed WAL replay, matching the existing low-memory shutdown/snapshot lifecycle behavior.
- Verification: `bun test src/db/migrateDuckdb.test.ts`; rerun `bun run db:mig`.

## 2026-07-03 - Full Posting Rebuild Source Materialization

- Error: Primary `ds` stack maintenance worker reached about 14GB RSS, then Bun exited with `panic: A C++ exception occurred` after full posting rebuild speed changes.
- Context: `projectReviewServingFilterPostings` inside review-serving `posting` rebuild chunks.
- Cause: The full rebuild path skipped generic serving/contribution record writes but still queried, diffed, sorted, and validated the full posting source in JS; completed posting chunks also skipped the native-heavy DuckDB recycle/GC path.
- Fix: Full posting rebuilds now return through a SQL-native early path for serving, contribution, stats, and count validation before source rows are materialized, and completed posting chunks recycle DuckDB/collect GC like other native-heavy chunks.
- Verification: `bun test src/server/reviewServing/reviewServingFilterPostingProjector.test.ts src/server/workers/reviewServingProjectorWorker.test.ts`.

## 2026-07-03 - Full Posting Rebuild Stats Regroup Per Chunk

- Error: Chunked full posting rebuilds still risked DuckDB OOM/native memory spikes because each article-range chunk ran an unbounded stats regroup over `mart.review_article_filter_posting_serving_v4`.
- Context: `projectReviewServingFilterPostings` set-based full rebuild chunks for the `posting` component.
- Cause: The stats refresh ignored `chunkStartArticleId`/`chunkEndArticleId` and ran inside every chunk write transaction.
- Fix: Posting rebuild chunks now defer stats refresh, and completed posting rebuild request finalization refreshes posting stats once per rebuilt snapshot before promotion.
- Verification: `bun test src/server/reviewServing/reviewServingFilterPostingProjector.test.ts src/server/workers/reviewServingProjectorWorker.test.ts`.

## 2026-07-03 - Full Posting Rebuild JS Fanout

- Error: Full posting rebuild chunks could still drive RSS/OOM spikes while materializing one JS serving record per live posting row.
- Context: `projectReviewServingFilterPostings` during full posting rebuild chunks using set-based serving/contribution writes.
- Cause: The full rebuild path skipped writing generic serving records but still built the discarded `servingRecords` array before the writer call.
- Fix: Full posting rebuilds now skip serving-record object creation and report the set-based row count from deduped live posting keys.
- Verification: `bun test src/server/reviewServing/reviewServingFilterPostingProjector.test.ts src/server/reviewServing/reviewServingProjectorWriter.test.ts`; live current-DB progress gate.

## 2026-07-03 - Snapshot Checkpoint OOM

- Error: `Failed to create checkpoint: Out of Memory Error: could not allocate block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` while `POST /__duckdb-owner-rpc/api/duckdbStudioSnapshots` served a current-DB snapshot.
- Context: Live primary `dev:server` maintenance owner under the 6400MiB profile during the required review-serving progress gate.
- Cause: `createDuckdbSnapshot` forced `CHECKPOINT` before copying the database for a read-only snapshot, which could allocate more memory than the constrained maintenance owner had available and fatally invalidate DuckDB.
- Fix: Snapshot creation now copies the database file and WAL under the existing append barrier without forcing a live checkpoint.
- Verification: `bun test src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts src/server/utils/duckdbScriptAccess.test.ts`; live current-DB progress gate.

## 2026-07-04 - Low-Memory Shutdown Checkpoint OOM

- Error: `Failed to create checkpoint: Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` during SIGTERM of the primary maintenance owner.
- Context: Required live current-DB review-serving progress gate under the 6400MiB maintenance profile.
- Cause: Shutdown forced `CHECKPOINT` even for serialized low-memory runtimes where the live database can already be at the memory cap.
- Fix: Low-memory DuckDB runtimes now skip shutdown checkpoint and rely on clean close plus WAL replay instead of fatally invalidating the process during shutdown.
- Verification: `bun test src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts src/server/utils/duckdbScriptAccess.test.ts`; live current-DB progress gate.

## 2026-07-03 - Invalid Candidate Promotion Snapshot Update

- Error: Live maintenance/dev-single owner crashed with Bun `panic: A C++ exception occurred`; isolated disposable-snapshot promotion crashed after `diag:beforePromote` and a minimal `UPDATE app.review_serving_snapshot_manifest ...` repro crashed at about 0.33-0.37GB RSS.
- Context: `promoteReviewServingProjectorSnapshot` for project `e43a0bbb-703e-4701-a223-7488c5b40cd0`, candidate snapshot `snapshot:2aabd7a2e4cdbf687fd0e15e8ef5e765`.
- Cause: The candidate was invalid because its selected-import snapshot was still `candidate`; the promotion failure path wrote validation/failed state back to `app.review_serving_snapshot_manifest`, hitting a DuckDB/Bun native crash on the current DB lineage.
- Fix: Invalid candidate promotion now returns the validation error without mutating the snapshot manifest row; request finalization can fail the rebuild request and surface the operator-blocked state without crash-looping the owner.
- Verification: `bun test src/server/reviewServing/reviewServingManifestRepository.test.ts`; disposable current-DB snapshot validation/promotion probes.

## 2026-07-03 - LLM Status Post-Chunk Maintenance Panic

- Error: The primary stacked maintenance owner completed one `llmStatus` chunk for `rebuild:06b41de63a109055af3a953938c60bb4`, then exited with Bun `panic: A C++ exception occurred` before the next useful cycle. Repro runs crashed repeatedly at about 1.4GB RSS after the chunk log; earlier runs with DuckDB recycle enabled crashed at about 7-12GB RSS.
- Context: Live current-DB probe after the invalid-candidate fix. The request belongs to project `d03fe24a-cfcf-41ed-b09f-7b554a393d80` and still had thousands of pending 64-row `llmStatus` chunks; it preempted the warning-route project because both active requests had priority `10000`.
- Isolation: Disabling per-small-chunk DuckDB close and forced `Bun.gc(true)` did not stop the panic. A controlled `process.exit(0)` after the chunk avoided the panic for that process but left the stacked-server supervisor stuck after `restarting maintenance`, so it was not a safe fix.
- Cause: macOS crash reports show `EXC_BREAKPOINT/SIGTRAP` from a DuckDB task-scheduler thread terminating inside `duckdb::DuckTransaction::Commit`, not a kernel OOM kill. Stable clone runs used the bounded maintenance profile (`DUCKDB_MEMORY_LIMIT=6400MiB`, `threads=1`, serialized background work); the crashing direct owner/probe paths fell back to the generic `20GB` default, which maps to `threads=8` and leaves native commit work in DuckDB's parallel scheduler.
- Fix: Direct maintenance/dev-single/auto owner startup now defaults to the same bounded maintenance DuckDB profile as the split maintenance worker instead of silently inheriting the generic API/default `20GB` profile. Explicit API processes keep the `20GB` default.
- Verification: Current-DB clone probes showed direct private warning reads and API-proxied warning reads survive after `llmStatus` chunk completion under `6400MiB`; crash reports confirm the historical abort site in `libduckdb.dylib`; focused DuckDB memory-limit tests cover the new owner default.

## 2026-07-02 - Low-Memory Startup Mutation Preflight

- Error: `DuckDB startup preflight failed ... signal=SIGTRAP`, `Failed to create checkpoint ... Out of Memory Error ... (6.2 GiB/6.2 GiB used)`, followed by Bun `panic: A C++ exception occurred` in the maintenance owner.
- Context: `bun dev:server` primary maintenance-worker startup/restart against the live DuckDB with missing review-serving snapshot work queued.
- Cause: The startup WAL preflight proactively ran mutating indexed-table probes for all repair specs under the 6400MiB maintenance profile, which can create large WAL/checkpoint pressure on live V4 tables before normal maintenance begins.
- Test gap: Existing startup/WAL tests covered recovery after replay/open failures and low-memory checkpoint thresholds, but did not assert that the primary maintenance-worker profile avoids the proactive all-table mutation probe before opening a large live database while still probing low-memory-safe worker-claim tables. The failure was therefore only visible in a current-DB dev stack run.
- Fix: Low-memory runtimes now skip only the proactive all-table startup mutation preflight when no active repair marker exists, but still run the bounded `review_rebuild_chunk_manifest` claim-path probe. Targeted recovery still runs if a prior failed preflight left a marker.
- Verification: `bun test src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts`.

## 2026-07-02 - Repaired Chunk Manifest Primary Index

- Error: Maintenance owner reached `Elysia is running at 0.0.0.0:3002` and then exited with Bun `panic: A C++ exception occurred` as soon as the projector worker tried to claim a rebuild chunk.
- Context: `app.review_rebuild_chunk_manifest` on the primary DuckDB after an earlier startup indexed-table repair. A direct no-op `UPDATE ... SET status = status WHERE chunk_id = ...` crashed, while updating non-indexed `last_error` did not.
- Cause: The indexed-table repair script copied DuckDB table DDL including inline `PRIMARY KEY`, so the repaired table kept an internal primary index identity derived from the temporary `_startup_repair_...` table. Later indexed `status` updates hit an internal duplicate-key error on that stale primary-index structure.
- Test gap: Existing repair tests asserted that a failed mutation preflight could trigger repair and reopen the DB, but did not inspect the generated repair DDL or prove that a repaired inline primary key table would be safe for subsequent indexed-column worker mutations. Synthetic worker tests also used freshly-created schemas, not a table lineage that had passed through startup repair.
- Fix: The repair script now strips inline primary-key constraints for tables that opt into `repairPrimaryKeyColumns`, then recreates a normal unique index after renaming the repair table. Low-memory startup runs the bounded chunk-manifest mutation probe so this worker-claim failure is caught before background loops begin.
- Verification: `bun test src/server/utils/duckdbServiceReload.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceMemoryLimit.test.ts`; current-DB clone reproduction before live repair.

## 2026-07-02 - Summary Rebuild Chunk Fanout

- Error: Maintenance owner repeatedly claimed `summary` rebuild chunks for project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf` and then exited before marking the chunk failed; live chunks were around 4,914 input articles, below the generic high-fanout presplit threshold.
- Context: Missing-snapshot review-serving rebuild on the primary DB. Summary chunk execution recomputed global filter-option rows while also processing an article range, so many range chunks multiplied a full-snapshot option refresh.
- Cause: `summary` used the generic 5,000-row high-fanout runtime presplit threshold even though its per-article path also fans out through summary counts/facets/options. The global filter-option refresh was also attached to every summary chunk instead of the completed rebuild request.
- Test gap: Existing rebuild tests covered large generic article-range presplitting and bounded summary admission, but not the observed near-threshold summary chunk size or the invariant that summary article-range chunks must not refresh global option tables per chunk.
- Fix: Summary chunks now presplit at a lower component-specific threshold, and summary filter options refresh once during completed request finalization.
- Verification: `bun test src/server/workers/reviewServingProjectorWorker.test.ts`.

## 2026-07-02 - Summary Rebuild Burst Memory

- Error: After startup and chunk-claim repair succeeded, the maintenance owner completed hundreds of `summary` rebuild chunks for project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf`, grew to roughly 11-14GB RSS, then exited with Bun `panic: A C++ exception occurred`.
- Context: Live current-DB progress check against the primary review-serving backlog. Recent manifest rows showed `summary` chunks completing rapidly up to `2026-07-02 19:47:13+02` immediately before the maintenance restart loop.
- Cause: The worker already recycled DuckDB after completed `llmStatus` and `humanStatus` chunks, but not after `summary` chunks. The recursive background loop could therefore run a long burst of summary chunks with no runtime recycle while native DuckDB/Bun memory accumulated.
- Test gap: Existing worker tests checked recycling for status chunks and functional summary chunk completion, but not the memory-control invariant that completed summary chunks also recycle the embedded DuckDB runtime during long rebuild backlogs. The gap only appeared under the live primary backlog with thousands of pending summary chunks.
- Fix: Completed `summary` rebuild chunks now trigger the same no-checkpoint DuckDB runtime recycle as status-heavy rebuild chunks.
- Verification: `bun test src/server/workers/reviewServingProjectorWorker.test.ts`; live current-DB progress gate.

## 2026-07-02 - LLM Status Rebuild Estimate Strings

- Error: Live full-rebuild `llmStatus` chunks around 4,961 estimated rows were claimed as single chunks, then repeatedly pushed the maintenance owner into high native memory and Bun `panic: A C++ exception occurred`.
- Context: `app.review_rebuild_chunk_manifest` rows persisted `estimated_input_rows` from DuckDB, and the worker pre-split path only accepted numeric JavaScript values.
- Cause: DuckDB returned some persisted numeric estimates as strings, so `Number.isFinite(chunk.estimatedInputRows)` failed and near-threshold `llmStatus` chunks skipped the component-specific pre-split budget.
- Test gap: Worker tests used in-memory numeric estimates, not rows hydrated from DuckDB-style string values, so they exercised the intended status split budget but missed the live serialization boundary.
- Fix: Article-range pre-split now coerces positive finite numeric strings before comparing component-specific budgets, and status chunks pre-split to 16-row child ranges for native-heavy live rebuilds.
- Verification: `bun test src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts`.

## 2026-07-02 - LLM Status Full-Rebuild Prompt Fanout

- Error: After chunk sizing was corrected, repeated small `llmStatus` full-rebuild chunks for project `d03fe24a-cfcf-41ed-b09f-7b554a393d80` still drove high RSS and maintenance restarts; warning/count routes then intermittently returned 502 because the owner died mid-request.
- Context: Full rebuild chunks call `projectReviewServingLlmStatusPatches` with no dirty claims and a bounded article range.
- Cause: The project-scoped LLM status query used both current project prompts and every prompt already present in the old `review_llm_status_patch_v4` base generation. The per-chunk serving-status update also re-read old patch rows for the changed articles. That legacy patch state is needed for dirty delta/project-review-config claims, but it is unnecessary and explosive during full rebuild chunks that delete/rewrite the scoped range at patch watermark 0.
- Test gap: Existing projector tests asserted the dirty project-review-config claim query included old patch prompts, but there was no full-rebuild chunk test asserting that empty-claim rebuilds only fan out over current enabled prompts and do not re-scan old patch rows while updating serving status. The live-only shape combined a no-claims rebuild range, a large old patch table, and real prompt history.
- Fix: Full rebuild chunks now use only current enabled, non-archived project prompts and compute serving status from the rebuilt rows only; dirty delta/project-review-config claims still union the previous patch state for tombstone and incremental coverage.
- Verification: `bun test src/server/reviewServing/reviewServingLlmStatusProjector.test.ts`.

## 2026-07-02 - Warnings Route Foreground Rebuild Mutation

- Error: `POST /api/projectsreviewswarnings` for project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf` returned 502 and the maintenance owner restarted with Bun `panic: A C++ exception occurred` when server mutations were enabled, while the same request survived with `FORSKA_DISABLE_SERVER_MUTATIONS=true`.
- Context: Missing-snapshot warnings response while the primary DB already had pending V4 rebuild chunks and the maintenance worker was active.
- Cause: The warnings route treated pending or expired rebuild chunks as a reason to boost or enqueue foreground missing-snapshot repair. That made a status/diagnostics request perform indexed writes against rebuild-request state while the owner was already processing rebuild chunks. The read-only diagnostics path was not the crash trigger.
- Test gap: Route tests covered disabled mutations and synthetic missing-snapshot bootstrap, but did not assert the current-DB invariant that a warnings request must not mutate rebuild priority/request state when diagnostics already show progressable V4 chunks. The current-DB gate had startup coverage, but not a mutation-enabled missing-snapshot warning probe during active maintenance work.
- Fix: The warnings route now requests foreground missing-snapshot repair only when diagnostics show no V4 state that can progress. Existing pending/running/claimable rebuild chunks are reported to the caller and left to the maintenance worker.
- Verification: `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`; live current-DB warning-route repro.

## 2026-07-02 - Low-Memory Maintenance Auto-Checkpoint Regression

- Error: `Failed to create checkpoint: Out of Memory Error: could not allocate block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` followed by DuckDB fatal invalidation during `importJudgmentsCron`.
- Context: Live current-DB progress gate with the primary split-runtime maintenance owner under the 6400MiB memory cap.
- Cause: The 6400MiB maintenance profile regressed to `checkpoint_threshold=1024MiB`, allowing DuckDB auto-checkpoint work to start while write-heavy maintenance was already at the memory cap.
- Fix: Low-memory serialized maintenance profiles at 4096-6400MiB now defer automatic checkpoints with an 8192MiB threshold again.
- Verification: `bun test src/server/utils/duckdbServiceMemoryLimit.test.ts`; live current-DB progress gate.

## 2026-07-01 - Low-Memory Checkpoint Shutdown

- Error: `Failed to create checkpoint: Out of Memory Error` during constrained DuckDB checkpoint or shutdown paths.
- Context: Embedded DuckDB startup tuning and close/shutdown behavior for low-memory maintenance-worker profiles.
- Cause: A fixed large checkpoint threshold and pre-close checkpoints could keep checkpoint work too large for low-memory runtimes or trigger extra checkpoint work while memory was already exhausted.
- Fix: Checkpoint threshold now scales with the configured DuckDB memory limit, low-memory workers serialize concurrent work, and shutdown/close paths avoid forcing an additional checkpoint.
- Verification: `bun test src/server/utils/duckdbServiceMemoryLimit.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceReload.test.ts`.

## 2026-06-30 - Mutating Current-DB Auto-Checkpoint

- Error: `Failed to create checkpoint: Out of Memory Error: could not allocate block of size 256.0 KiB (6.2 GiB/6.2 GiB used)`.
- Context: `bun run test:dev-server:current-db` running mutating maintenance/review-serving work against the primary DuckDB under the 6400MiB maintenance cap.
- Cause: DuckDB's default low auto-checkpoint threshold could force a checkpoint inside hot background write work while the constrained runtime was already at its memory cap.
- Fix: The embedded DuckDB runtime now sets an explicit 8GB `checkpoint_threshold`, deferring automatic checkpoints so write-heavy maintenance paths are not interrupted by low-threshold auto-checkpoints.
- Verification: `bun test src/server/utils/duckdbServiceMemoryLimit.test.ts`; `bun run test:dev-server:current-db`.

## 2026-06-30 - Startup And Shutdown Checkpoints

- Error: `Failed to create checkpoint: Out of Memory Error: could not allocate block of size 256.0 KiB (6.2 GiB/6.2 GiB used)`.
- Context: `bun run test:dev-server:current-db` starting and stopping `bun run dev:server` against the primary current DuckDB.
- Cause: `migrateDuckdb()` ran `CHECKPOINT` on every startup even when all migrations were already applied, and signal/fatal-recovery close paths could force another checkpoint while memory was already exhausted.
- Fix: DuckDB migrations now checkpoint only after at least one migration file is applied; no-op migration close, fatal recovery close, and signal shutdown close skip the pre-close checkpoint.
- Verification: `bun test src/db/migrateDuckdb.test.ts src/server/utils/duckdbServiceShutdown.test.ts src/server/utils/duckdbServiceReload.test.ts`; `bun run test:dev-server:current-db`.

## 2026-06-30 - V4 Runtime OOM Chunk Split

- Error: `DuckDB Out of Memory Error` while executing a claimed V4 article-range rebuild chunk.
- Context: `reviewServing.projector.worker` rebuild chunk execution for splittable article-range components.
- Cause: A chunk admitted within static budgets can still exceed runtime DuckDB memory on dense article ranges or payload-heavy work.
- Fix: Runtime DuckDB OOM now splits the claimed article-range chunk into bounded child chunks and completes the parent as a container so the worker can resume smaller work units.
- Verification: `bun test src/server/workers/reviewServingProjectorWorker.test.ts`.

## 2026-06-30 - V4 Rebuild Chunk Claim Discovery

- Error: `DuckDB workload budget exceeded for reviewServing.projector.worker: temp spill 819200 bytes is not allowed`.
- Context: Live maintenance worker claim discovery for admitted V4 `missingReviewServingSnapshot` rebuild chunks on project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf`.
- Cause: The claim query used multi-pass global `MIN(...)` CTEs over claimable chunk rows before fetching one chunk, which could spill temp data under the projector worker no-spill workload budget.
- Fix: Claim discovery now probes one component at a time in dependency order with the same admission, request, retry, and prerequisite predicates and `LIMIT 1`, avoiding the global min/sort shape and broad prerequisite-graph scan.
- Verification: `bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts` and live maintenance-worker progress check.

## 2026-06-30 - V4 Bootstrap Project Scope Admission

- Error: `missingReviewServingSnapshot` V4 bootstrap request remained `blocked_over_budget` with `input rows: estimated 2597735 > max 250000` after re-request.
- Context: Live V4-only project `0dc6463f-ba0d-4c8e-8337-f92bba016224`, request reason `missingReviewServingSnapshot`; legacy dirty materialization was completed and V4 dirty work was empty.
- Cause: Bootstrap admission still treated `projectScope` as a full-project chunk, so large project scopes could dominate the combined request estimate after other components were range chunked.
- Fix: Project-scope bootstrap chunks are now article-range chunks, and worker pre-splitting includes project-scope rebuild chunks.
- Verification: `bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts`.

## 2026-06-30 - V4 Bootstrap Selected Import And Summary Admission

- Error: `missingReviewServingSnapshot` V4 bootstrap request remained `blocked_over_budget` with `input rows: estimated 1395741 > max 250000` after candidate-only bootstrap recovery.
- Context: Live V4-only project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf`, request reason `missingReviewServingSnapshot`; no legacy mart mutation path involved.
- Cause: Bootstrap admission still treated `selectedImport` and `summary` as full-project components; selected-import rebuild execution also reset/drained the shared snapshot per chunk, so range admission was unsafe.
- Fix: Bootstrap admission now keeps only `projectScope` full-project, admits `selectedImport` and `summary` as bounded article-range chunks, and selected-import rebuild chunks use a range-scoped projection path for bootstrap/split chunks.
- Verification: `bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts` and touched-file ESLint.

## 2026-06-29 - V4 Candidate-Only Bootstrap Admission

- Error: Candidate-only V4 snapshot recovery created `blocked_over_budget` requests with `estimatedInputRows 2233116 > max 250000` after an OOM/bootstrap attempt left no active snapshot.
- Context: `scripts/requestReviewServingProjectRebuild.ts` for project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf`, reasons `operatorRetryAfterV4OomFix` and `missingReviewServingSnapshot`.
- Cause: V4 rebuild stats counted candidate snapshots as `snapshotCount`, so missing-snapshot admission skipped fresh/bootstrap chunking even when no active usable snapshot existed.
- Fix: V4 request admission now tracks active snapshots separately and treats `missingReviewServingSnapshot` with no active snapshot as bootstrap work while preserving queued candidate+active snapshot counts for normal estimates.
- Verification: `bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts`.

## 2026-06-29 - V4 Terminal Rebuild Re-Admission

- Error: `DuckDB OOM failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` left a V4 rebuild request terminal failed with failed/blocked `selectedImport` chunks and downstream pending chunks.
- Context: Operator re-request of `missingReviewServingSnapshot`/large V4 rebuild work for project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf` after the terminal request was surfaced in warnings.
- Cause: Same-request V4 re-admission updated status/admission fields but could preserve terminal request metadata such as `failed_at`/`last_error`, and retryable inactive chunks could retain stale execution timestamps/counts after being reset.
- Fix: V4 request upsert now clears failure, completion, lease, and retry metadata on re-admission; inactive request chunk release/upsert clears stale execution metadata while preserving active running/failed/completed chunks only where intended.
- Verification: `bun test src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts`.

## 2026-06-29 - V4 Failed Rebuild Request Warning State

- Error: `DuckDB OOM failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` left a `missingReviewServingSnapshot` V4 rebuild request in terminal `failed` status while downstream chunks stayed pending.
- Context: Current-DB review warnings for project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf` reported queued review indexing with eligible consumers and no running chunks.
- Cause: Warning diagnostics counted retryable/pending chunks but did not count the latest terminal V4 rebuild request as failed work, so an unclaimable failed request collapsed into healthy queued progress.
- Legacy rule-out: live legacy `project_mart_*` rows for the affected project were idle/completed residue, not active blockers: dirty refresh was fully caught up, dirty materialization was completed, quarantine was empty, and the old large-rebuild row had no current error.
- Fix: V4 diagnostics now surface the latest terminal failed/quarantined rebuild request as `failedCount`, and warning status treats that as terminal without converting it into queued work.
- Verification: `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`.

## 2026-06-29 - V4 Selected Import Rebuild Chunk

- Error: `DuckDB Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)`.
- Context: Live V4 `selectedImport` rebuild chunks for project `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf`, request reason `missingReviewServingSnapshot`.
- Cause: The full-project selected-import rebuild reset, base batch drain, patch projection, checksum validation, and chunk completion ran inside one DuckDB transaction, retaining too much work before downstream chunks could proceed.
- Fix: Selected-import rebuild now keeps one logical prerequisite chunk but runs reset, base batches, patch projection, and final validation/completion in separate transactions.
- Verification: `bun test src/server/workers/reviewServingProjectorWorker.test.ts` and touched-file ESLint.

## 2026-06-27 - V4 Judgment Input Content Rebuild Chunk

- Error: `DuckDB Out of Memory Error: failed to allocate 32KiB (18.6 GiB/18.6 GiB used)`.
- Context: `app.review_rebuild_chunk_manifest` V4 chunk `projection_component=judgmentInputContent` for project `d03fe24a-cfcf-41ed-b09f-7b554a393d80`, surfaced by current-DB network smoke warnings `failedCount`.
- Cause: A judgment detail rebuild chunk could still execute too much physical payload work for a dense article range before the manifest could resume at a smaller unit.
- Fix: Large claimed article-range rebuild chunks now split their article range through `mart.project_scope_article` into enough bounded child buckets before running dense payload work; DuckDB OOM in judgment input content still triggers the same split fallback. The worker inserts child rebuild chunk manifests and completes the parent as a container so downstream work waits for bounded children.
- Verification: `bun test src/server/workers/reviewServingProjectorWorker.test.ts` and focused lint for touched files.

## 2026-06-27 - V4 Re-Admitted Rebuild Queue

- Error: Current-DB warning smoke stayed `queued` for project `8e26a3a8-2797-41da-864e-2c6cec7615c4` with `pendingRefreshCount=100`, `activeWorkCount=0`, and old `blocked_over_budget` prerequisite chunks.
- Context: `app.review_rebuild_chunk_manifest` request-owned V4 repair chunks after a same-request re-admission created newer pending chunks.
- Cause: Chunk claim prerequisites treated older terminal chunks from the same re-admitted request as active blockers, so newer admitted chunks could be queueable in diagnostics but not claimable in the worker.
- Fix: Claim prerequisites now ignore older terminal prerequisite chunks when the candidate chunk is newer, allowing the re-admitted request to progress through the current bounded children.
- Verification: `bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/workers/reviewServingProjectorWorker.test.ts`; current-DB network smoke keeps failing failed/stalled/unqueueable warning states while allowing a queueable V4 backlog.

## 2026-06-26 - Judgment Job Serving Queue Cutover

- Error: `Out of Memory Error: failed to pin block` risk from normal judgment-job unassessed count, preview, and refill reads falling back to broad legacy DuckDB paths.
- Context: PR 92 DuckDB OOM call-site audit for judgment job serving routes and queue refill.
- Cause: Foreground job paths still depended on legacy OLAP-style unassessed reads or insufficiently bounded serving-queue reads during config, prompt, and cursor edge cases.
- Fix: Job unassessed reads use current V4 serving snapshots, current enabled prompts, stable priority/date/article/prompt keyset pagination, distinct preview articles, inclusive project end dates, and no-spill workload contexts.
- Verification: Focused Bun tests for review-serving SQL guards and judgment-job SQLite/add-to-queue cursor behavior.

## 2026-06-26 - Current DB Retired Serving Warning Health

- Error: `warning response returned stalled review indexing: progressState=stalled, status=stale, pendingRefreshCount=0, queuedRefreshCount=0, inFlightRefreshCount=0, activeWorkCount=0`.
- Context: Current-DB `bun run test:network-smoke:current-db` probing `POST /api/projectsreviewswarnings` for project `8e26a3a8-2797-41da-864e-2c6cec7615c4`.
- Cause: The warning route treated accepted retired V4 serving manifests as readable but not usable, and then still classified no-current-V4-state projects as stalled or queueable based on retired legacy dirty-refresh/large-rebuild rows that warning reads must not repair.
- Fix: Warning health now classifies accepted active or retired V4 serving manifests as usable, treats no-current-V4-state warning health as completed indexing while keeping missing V4 serving diagnostics marked unreadable/unusable, and only reports legacy refresh counters when usable/current V4 state exists or active/blocking legacy work must still be surfaced.
- Verification: `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`; `bun run test:network-smoke:current-db`.

## 2026-06-25 - Current DB Warning Legacy Rebuild State

- Error: `warning response returned failed review state: data.indexing.largeRebuild.refreshStatus=failed, data.indexing.progressState=failed, data.indexing.status=failed`.
- Context: Current-DB `bun run test:network-smoke:current-db` probing `POST /api/projectsreviewswarnings` for project `d03fe24a-cfcf-41ed-b09f-7b554a393d80`.
- Cause: The normal warning route still treated retired legacy V3 `app.project_mart_large_rebuild_state.refresh_status = 'failed'` as product review indexing failure, even when current V4 serving state is the read path.
- Fix: Failed legacy large-rebuild rows are no longer returned as normal `largeRebuild` progress and no longer contribute pending or failed warning health; dirty refresh/materialization and V4 rebuild chunk failures still drive failed state.
- Verification: `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`.

## 2026-06-25 - Network Smoke OOM Cutover Gate

- Error: `Large rebuild failed` browser/API/server output could pass network smoke without being treated as an OOM cutover regression.
- Context: Phase 5C current-DB browser smoke, `POST /api/projectsreviewswarnings`, route load diagnostics, and captured Playwright server logs.
- Cause: The smoke gate needed real-first then synthetic-second documentation, explicit skipped-route classifications, and broader `Large rebuild failed` detection across page, API, console, and server output.
- Fix: Added Phase 5C/master smoke gates, classified skipped routes, added current-DB warning probes for discovered projects, and fail the smoke pass on `Large rebuild failed` in warning responses, page HTML, document/fetch/XHR responses, console/page errors, or runtime logs.
- Verification: `bunx playwright test tests/e2e/networkSmoke.spec.ts -g "network smoke route inventory stays explicit"`, `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`, `bun run lint`, `bun run test:network-smoke`, and `bun run test:network-smoke:synthetic`.

## 2026-06-25 - Network Smoke Warning Failure Variants

- Error: Failed review-warning states from `POST /api/projectsreviewswarnings` could pass current-DB network smoke unless they rendered the exact `Large rebuild failed` text.
- Context: Phase 5C current-DB browser smoke and route-loaded warning responses for review pages.
- Cause: The smoke gate checked HTTP errors and one failure string but did not parse warning payloads for failed status variants or failed-count diagnostics.
- Fix: Current-DB warning probes and route-loaded warning responses now fail on any `failed` warning status value or positive `failedCount` in the warning payload.
- Verification: `bunx playwright test tests/e2e/networkSmoke.spec.ts -g "network smoke route inventory stays explicit"` and `bun run test:network-smoke:synthetic`.

## 2026-06-25 - Network Smoke OOM Cutover Follow-Up

- Error: `Out of Memory Error: failed to pin block` class from legacy DuckDB review-serving maintenance and network-smoke cutover regressions.
- Context: Phase 5C network-smoke regression gate, V4 rebuild chunks, missing-snapshot projector wakeups, and selected-import display patches.
- Cause: Terminal failed chunks could leave rebuild requests admitted/running forever, validation failures could leave partial mart output behind, rebuild admission failures could strand dirty claims until lease expiry, and selected-import display updates needed patch coverage.
- Fix: Terminal chunk failures now fail the owning rebuild request, failed output validation rolls back chunk writes before marking the chunk failed, failed missing-snapshot rebuild admission fails claimed dirty work, and selected-import patch tests cover title/external ID/source URL freshness.
- Verification: Focused review-serving projector, worker, chunk manifest, and display payload tests.

## 2026-06-24 - Phase 5B Review Thread Follow-Up

- Error: Review found V4 warning state could stay failed after superseded terminal request chunks, dirty recovery could enqueue duplicate full-project V4 rebuilds, and rebuild admission estimates ignored list-mode fan-out.
- Context: `projectsRoutesGetReviewsWarnings`, `recoverDirtyRefreshClaims`, and `reviewServingV4RebuildRequestService`.
- Cause: Diagnostics counted terminal chunks project-wide, stale legacy categories queued separate request IDs for the same project, and row budgets used one row per component/article or judgment instead of display/status/payload list-mode expansion.
- Fix: Terminal rebuild chunk diagnostics now apply only to the latest request, stale legacy recovery coalesces projects into one V4 request before releasing rows, and V4 estimates multiply article, prompt, and payload rows by component-specific fan-out.
- Verification: Focused Bun tests for warnings, diagnostics, recovery, and V4 rebuild request admission; targeted ESLint on touched files.

## 2026-06-24 - Phase 5B V4 Rebuild Request Review Fixes

- Error: Review found V4 rebuild requests admitted project-scale work with `estimatedInputRows` based only on component count, default chunks with synthetic identities and sentinel article bounds, and failed chunks without retry backoff.
- Context: `app.review_rebuild_request`, `app.review_rebuild_chunk_manifest`, V4 review-serving rebuild request scripts, and the projector chunk worker.
- Cause: Request-created chunks did not inherit active/candidate projection identities or real article ranges, request IDs did not include live data watermarks, budget admission underestimated scoped articles/prompts/judgments, and failed chunks could be reclaimed without cooldown.
- Fix: Default chunks now use existing snapshot/manifest identities and project article bounds, request estimates and source watermarks come from project data, diagnostics surface blocked chunks, chunk claim/retry metadata is qualified and bounded, and the legacy dirty-refresh fallback requires the large-rebuild ack.
- Verification: Focused Bun tests for the touched request, chunk manifest, diagnostics, V4 request service, and static guard paths.

## 2026-06-23 - Legacy Judgment Fact Large Rebuild

- Error: DuckDB OOM during the staged background `judgment_fact` large rebuild; the failing shape built `temp_project_judgment_fact_article` from a large inline `VALUES (...)` article list before deleting and reinserting `mart.judgment_fact` rows from raw `app.judgment`.
- Context: Legacy project mart large-rebuild maintenance path still available after normal review reads moved toward V4 serving contracts.
- Cause: The legacy phase was chunked by article count but not by prompt density, judgment rows, payload bytes, temp risk, retry behavior, or V4 manifest ownership, so a background rebuild could still scan, hash, delete, and reinsert project-scale fact state under the shared DuckDB cap.
- Fix: Phase 5B plan now requires retiring or V4-rewiring legacy refresh/rebuild, dirty-refresh, repair/recovery, warning/admin, startup/heartbeat, package-script, and adjacent browser fallback paths; it also adds V4 rebuild request admission, component-specific chunk budgets, retry cooldown/split/quarantine behavior, durable OOM telemetry, and Phase 6 adversarial OOM proof gates.
- Verification: Five Codex review passes integrated into `DUCK_CQRS_PLAN_PHASE_5B.md`, `DUCK_OOM_FIX_PLAN.md`, and `DUCK_CQRS_PLAN_PHASE_6.md`; implementation and runtime verification remain Phase 5B/Phase 6 work.

## 2026-06-23 - Phase 5B V4 Rebuild Request Admission

- Error: Legacy rebuild and repair requests could still create or resume article-count chunks that only discovered dense judgment/payload/temp risk after DuckDB execution began.
- Context: Phase 5B request layer above `app.review_rebuild_chunk_manifest`.
- Cause: Chunk manifests existed, but there was no durable request-level admission record carrying requested components, identities, retry policy, estimates, budget diagnostics, or over-budget state before chunks became claimable.
- Fix: Added `app.review_rebuild_request`, request-owned chunk manifest fields, request admission, budget/diagnostic fields, retry-after/over-budget metadata, and claim gating so request-owned chunks are claimable only after the parent request is admitted.
- Verification: `bun test src/server/reviewServing/reviewServingSchema.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts`.

## 2026-06-23 - Phase 5B Operator Request Cutover

- Error: Normal operator scripts named around large rebuild and `judgment_fact` repair still requested legacy `project_mart_large_rebuild_state` work.
- Context: `scripts/requestProjectLargeRebuild.ts`, `scripts/requestReviewServingAllProjectsRebuild.ts`, and `scripts/requestJudgmentFactRepair.ts`.
- Cause: The scripts called `getDuckdbMartMaintenanceService().requestProjectLargeRebuild*`, preserving the old seven-phase mart rebuild chain as a normal recovery path.
- Fix: Rewired the scripts through `reviewServingV4RebuildRequestService.ts` so they create admitted `app.review_rebuild_request` rows and request-owned chunk manifests; `requestJudgmentFactRepair` now requires explicit project selection and no longer scans `mart.judgment_fact` by default.
- Verification: `bun test scripts/requestReviewServingAllProjectsRebuild.test.ts scripts/requestProjectLargeRebuild.test.ts scripts/requestJudgmentFactRepair.test.ts`; focused ESLint on the touched scripts, tests, and V4 request service.

## 2026-06-23 - Phase 5B Startup And Legacy Worker Cutover

- Error: Normal maintenance startup and package scripts could still mount legacy refresh and seven-phase large-rebuild workers after V4 rebuild request admission existed.
- Context: `src/server/utils/startBackgroundWork.ts`, `package.json`, `scripts/runLargeRebuildWorkerOnce.ts`, and `scripts/runLargeRebuildWorkerCycles.ts`.
- Cause: The startup path gated on legacy mart-refresh drain eligibility and then started legacy refresh/large-rebuild heartbeats; package commands exposed unguarded legacy large-rebuild worker entrypoints.
- Fix: Removed legacy refresh/large-rebuild heartbeat startup from normal maintenance work, kept the V4 projector heartbeat as the normal rebuild executor, renamed package commands to explicit `legacy-admin-*`, and required `--legacy-admin-ack=legacy-large-rebuild` for direct legacy worker execution.
- Verification: `bun test src/server/utils/startBackgroundWork.test.ts scripts/rebuild2PackageCommands.test.ts scripts/runLargeRebuildWorkerOnce.test.ts scripts/runLargeRebuildWorkerCycles.test.ts`; focused ESLint on the touched startup, package-script, legacy-admin, and recovery compatibility tests.

## 2026-06-23 - Phase 5B Recovery And Warning Side Effects

- Error: Recovery and warning/status paths could still resume or schedule legacy refresh and large-rebuild work as a side effect of inspection.
- Context: `scripts/recoverDirtyRefreshClaims.ts` and `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`.
- Cause: `recoverDirtyRefreshClaims --recover` shelled into legacy refresh and large-rebuild workers; review-warning reads scanned `mart.judgment_fact`, marked dirty repair state for missing facts, and bootstrapped missing serving rows through legacy large rebuild requests.
- Fix: Recovery now enqueues V4 `app.review_rebuild_request` rows and leaves stale legacy claims as diagnostics; review-warning reads no longer scan `mart.judgment_fact` or schedule legacy dirty/large-rebuild repair, reporting stale V4 state instead.
- Verification: `bun test scripts/projectMartRefreshRecovery.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts`; focused ESLint on the touched recovery script and warning route/tests.

## 2026-06-23 - Phase 5B Legacy Admin Guards

- Error: Direct legacy dirty-refresh worker scripts could still be run without an explicit acknowledgement, and the Phase 5B cutover decisions had no focused regression guard.
- Context: `scripts/runProjectMartRefreshWorker*.ts`, `scripts/runLargeRebuildWorker*.ts`, startup, package scripts, warning route, and dirty recovery script.
- Cause: Startup and package cutover reduced normal exposure, but direct script execution and future edits could reintroduce legacy refresh/rebuild OOM paths without a static test failing.
- Fix: Added `legacy-dirty-refresh` acknowledgement checks to direct dirty-refresh worker scripts and added Phase 5B static guards covering startup, warning side effects, V4 recovery, package command exposure, and required legacy-admin acknowledgements.
- Verification: `bun test src/server/reviewServing/reviewServingPhase5BStaticGuards.test.ts scripts/projectMartRefreshRecovery.test.ts`; focused ESLint on the touched scripts and static guard test.

## 2026-06-23 - Review Serving Projector Chunk Claim

- Error: `DuckDB workload budget exceeded for reviewServing.projector.worker: temp spill 11206656 bytes is not allowed` from the rebuild chunk claim query.
- Context: `reviewServingProjectorWorker` calling `getNextClaimableReviewServingRebuildChunk` against `app.review_rebuild_chunk_manifest`.
- Cause: The claim path sorted all claimable rebuild chunk manifest rows by `updated_at`, `input_watermark`, `chunk_start_key`, and `chunk_id` before `LIMIT 1`, spilling temp data under the no-spill projector workload budget.
- Fix: Replaced the full-row `ORDER BY ... LIMIT 1` with aggregate tie-break CTEs that select the next `chunk_id` via `MIN(...)`, then fetch only that manifest row while keeping temp spill disallowed.
- Verification: `bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/workers/reviewServingProjectorWorker.test.ts src/server/utils/reviewServingProjectorWorkerHeartbeat.test.ts`; `bun run lint`; in-memory DuckDB parser/runtime check for `getNextClaimableReviewServingRebuildChunk`.

## 2026-06-20 - Desktop DuckDB Runtime Memory Default

- Error: Desktop backend could start without an explicit DuckDB cap, leaving laptop/default runtimes exposed to the same `failed to pin block` class of DuckDB OOM under review-serving overlap workloads.
- Context: Phase 5 Part 2 desktop backend startup through `getDesktopRuntimeConfig` and shared review-serving projector, job, search, cleanup, and route runtime paths.
- Cause: Browser/server profiles already had low-memory DuckDB worker behavior, but desktop startup did not provide a bounded default `DUCKDB_MEMORY_LIMIT` when the operator had not set an override.
- Fix: Desktop backend now defaults `DUCKDB_MEMORY_LIMIT` to `6400MiB` while preserving explicit operator overrides; the existing DuckDB service maps limits at or below `6400MiB` to reduced concurrency and serialized work.
- Verification: `bun test src/desktop/getDesktopRuntimeConfig.test.ts src/server/reviewServing/reviewServingDesktopInterruptionEvidence.test.ts`; `bun run desktop:build`; Phase 5 closure audit targeted gates on 2026-06-20.

## 2026-06-13 - Review Serving V4 Foundation

- Error: `Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` from foreground review reads under import/materialization overlap.
- Context: Phase 1 foundation for review rows, counts, facets, queues, search, bulk/export/PDF jobs, and DuckDB foreground workload admission.
- Cause: Normal review reads still lacked durable serving-only schema and generic runtime budget hooks needed to prevent project-scale raw scans from reaching DuckDB.
- Fix: Added empty `_v4` serving/control schema plus optional DuckDB workload contexts with row/byte/temp/elapsed budget enforcement and metrics.
- Verification: `bun test src/server/reviewServing/*.test.ts src/server/utils/duckdbServiceWorkloadContext.test.ts`; `bun test src/server/utils/duckdbService*.test.ts`; isolated temp migration through `0097_reviewServingV4Foundation.sql`.

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
