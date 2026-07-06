# Review Serving Rebuild Speed Plan

## Scope

Make the V4 review-serving rebuild path fast enough for the review page's normal "missing snapshot" path. This plan tracks the investigation plus the implementation slices landed from it.

Status: PR #108's safe implementation slices are complete, and the follow-up rebuild-speed slices removed claimless article-range `judgmentInputContent` rebuild JS materialization, selected-import article-range rebuild JS materialization, selected-import rebuild patch production/reads in rebuild sources, dirty incremental legacy patch-table reads/writes, requestless ranged summary quarantine, full summary contribution-state publication, runtime summary contribution ledger dependency, and the remaining unbatched status/posting worker paths. The remaining roadmap should prefer durable direct snapshot/reduction designs over deferring risky rewrites solely for caution.

## Implementation Audit - Post PR #108 Merge

Current implementation status after PR #108 merged, based on source inspection against this plan:

| Phase | Status | Current Evidence |
| --- | --- | --- |
| Phase 0 - Instrument Before Optimizing | Implemented for current rebuild executors | Chunk completion now writes `duration_ms`, actual output rows/bytes/payload bytes, and `diagnostics_json`; cheap validation records `validationMode`; chunk diagnostics include write/validation timing splits; worker progress logs include claim/heartbeat/execute/finalize/recycle/GC timings; the generic writer reports record counts/batches/write ms per table; posting, summary, judgment-payload, display/payload, selected-import, title-search, queue, LLM status, and human status rebuild paths report source-query/transform/delete-reset/writer timing splits where those phases exist; SQL-native batch wrappers record batch writer timing; `db:duck:inspect-review-serving-rebuild-timings` summarizes per-request timings and claimable pending chunks. |
| Phase 1 - Fix The Scheduler | Mostly implemented | Claiming now uses component prerequisites and critical-lane/priority ordering instead of the old fixed waterfall; tests cover independent claimability. Foreground rebuild drain budget/TTL exists. Chunks now persist a durable `workload_class` of `critical` or `bulk`, and claim ordering uses it with a component fallback for old rows. The worker can now run a bounded configurable rebuild chunk batch per wake, defaulting to one chunk until enabled. |
| Phase 2 - Batch Or SQL-Native Writes | Mostly implemented | Generic record writes are batched by table/key/shape in `writeReviewServingProjectorRecords`; `search` and `queue` rebuilds have SQL-native `INSERT INTO ... SELECT` paths. Full posting rebuilds now use a set-based SQL statement for serving rows instead of sending those rows through the generic projector writer, and posting no longer writes or reads posting summary contribution rows for full or incremental stats. Incremental posting stats now derive from existing serving rows plus changed rows. Judgment payload rebuilds and dirty incremental payload updates now write detail rows with SQL-native `INSERT INTO ... SELECT` statements while preserving dirty-work acknowledgements, projection manifests, and projector watermarks; selected-import rebuild chunks now write base rows with SQL-native `INSERT INTO ... SELECT` and refresh final serving rows directly from base rows. |
| Phase 3 - Add A Full-Rebuild Fast Path | Mostly implemented | Missing-snapshot requests can create a bootstrap candidate snapshot and explicit bootstrap chunks. Several rebuild chunk executors write base/candidate rows directly, full posting rebuilds now skip incremental posting patch rows and posting contribution state, use set-based serving writes, and summary rebuild chunks leave global filter-option refresh to request finalization. Fresh candidate snapshots with no selected-import patch watermark now skip candidate patch-compaction scans. Unchunked full summary rebuilds now replace final count/facet serving rows directly and skip summary contribution state. Chunked request-associated full summary rebuilds now write range-scoped summary partial rows, and request finalization first reduces those partials into bounded accumulator rows before writing final count/facet serving rows and promotion. Claimless full summary rebuild chunks derive contribution source rows from rebuilt serving/detail tables instead of status patch tables, and summary finalization derives accumulator counts from request-scoped contribution partial rows instead of publishing to `mart.review_article_summary_contribution_v4`. Rebuild `llmStatus` and `humanStatus` chunks update final serving columns without writing or reading `*_status_patch_v4` rows; queue rebuild chunks derive queue rows directly from source judgment tables; and rebuild request admission derives prompt state from active project prompts instead of status patch rows. Selected-import rebuild chunks now write base rows and final serving rows directly without `mart.review_selected_import_patch_v4` output, and display/payload/title-search/queue/posting full rebuild source reads use selected-import base rows without patch overlays. Dirty incremental projectors now write/read direct serving/base/detail tables and retain dirty-work acknowledgement, manifest, watermark, and active/candidate semantics without runtime legacy patch tables; retention patch budget/compaction/cleanup is a no-op for those legacy patch tables. |
| Phase 4 - Make Validation Proportional | Mostly implemented | `getRebuildChunkOutputValidation` keeps strict checksum validation when `chunk.checksum` is present and uses cheap count validation with `validationMode: 'cheap-count'` when it is null. `FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION=true` forces full checksum diagnostics for targeted parity/debug runs. Full posting rebuild chunks can return a lightweight `post-write-serving-count` validation result from the projector and avoid the generic checksum validation path. Tests cover these modes. |
| Phase 5 - Rework Chunk Admission | Implemented | Default rebuilds and missing-snapshot bootstrap can presplit at admission using estimate/budget-derived article ranges; default single-component rebuilds now use component-specific input-row budgets for high-fanout components. Runtime input-budget presplitting has been removed; legacy rows and non-OOM misestimated chunks execute directly, while DuckDB OOM splitting remains as the safety fallback. |
| Phase 6 - Controlled Parallelism | Complete for production-safe single-writer rebuild execution | The worker now supports a configurable `rebuildChunkBatchSize` that can claim and execute multiple rebuild chunks in one wake while preserving the existing serialized writer lane; the maintenance heartbeat wires this to `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE`, defaulting to 2. Default maintenance batching is guarded by an auto `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES` cap derived from system memory, and explicit env overrides can still force single-chunk or disable the cap. Compatible requestless ranged fresh `projectScope` chunks and requestless ranged `selectedImport`, `display`, `payload`, `search`, `llmStatus`, `humanStatus`, `queue`, `judgmentInputContent`, and `posting` chunks now use component-specific SQL-native multi-range writes through one serialized writer transaction before per-chunk validation/completion; those audited SQL-native paths have no separate JS reader/transform preparation phase and were left unchanged. The generic compatible fallback now supports bounded preclaimed chunk preparation in parallel, capped by the same effective batch size/RSS guardrails, then submits prepared outputs through serialized writes. Request chunks and summary chunks intentionally stay single-claim. Batch-writer failures now fail every preclaimed chunk instead of leaving later chunks running until lease expiry. A narrow DuckDB append-transaction primitive now exists behind `FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED=true`, uses append lanes with low-memory serialization, records workload diagnostics when a context is supplied, and rolls back failures before releasing the lane. Production rebuild chunks do not use it yet; true rebuild multi-writer remains blocked behind live benchmark/write-conflict/memory-spill evidence. |

Summary: the plan is no longer a pure future plan. Scheduler ordering, foreground priority/drain, cheap validation, generic batched writes, SQL-native search/queue rebuild writes, full-posting set-based serving writes, full/incremental posting contribution-state removal, lightweight posting validation, bootstrap missing-snapshot admission, admission presplitting from active project prompts instead of status patch rows, runtime input-budget presplitting removal with DuckDB OOM fallback, high-fanout timing diagnostics, summary finalization cleanup, unchunked direct full-summary serving writes, bounded accumulator reduction/finalization for chunked request-associated full-summary partials, full summary rebuild source reads from rebuilt serving/detail tables, requestless ranged summary adoption into deterministic internal requests, summary full-rebuild contribution-table publication removal, runtime summary contribution ledger removal, fresh no-patch compaction short-circuiting, rebuild direct LLM/human status serving updates without patch rows, queue rebuild source decoupling from status patch rows, claimless article-range judgment-payload SQL-native writes, selected-import rebuild SQL-native base writes plus direct serving refresh and patch-table-free reset, selected-import patch-overlay removal from direct rebuild sources, dirty incremental direct-table projection without legacy runtime patch tables, configurable serial chunk batching, the first bounded fallback read/transform preparation lane, and an opt-in append-transaction service primitive have landed. Production rebuild execution remains intentionally single-writer until controlled DuckDB multi-writer evidence exists.

## Slice 5 Closure

Additional bounded implementation slices remain only where an existing SQL-native component can safely reuse compatible range-disjoint preclaiming and the serialized writer lane. Avoid scaffolding-only parallelism because incorrect versions could change snapshot semantics, increase DuckDB memory pressure, or introduce multi-writer conflicts without proving speed or correctness.

Immediate sensible work completed in this PR:

1. Full posting rebuilds skip posting contribution fanout and write serving rows set-based.
2. Runtime input-budget presplitting is removed, while DuckDB OOM splitting remains as a safety net.
3. Unchunked full summary rebuilds write final count/facet serving rows directly.
4. Judgment payload rebuilds avoid the extra combined writer-record array and expose materialized fanout diagnostics.
5. Request-associated chunked full summary rebuilds write range partials and reduce them through bounded accumulator batches at completed-request finalization before snapshot promotion.
6. Posting no longer writes posting summary contribution rows or reads them for incremental stats; changed posting stats are derived from serving-table counts plus changed rows.
7. Requestless ranged summary chunks are adopted into deterministic internal rebuild requests, so the modern partial/reduction/finalization path handles them instead of quarantining or preserving legacy contribution-table writes.
8. Rebuild LLM and human status chunks skip `mart.review_llm_status_patch_v4` and `mart.review_human_status_patch_v4` writes and update final serving state directly; queue rebuilds now derive from source judgment tables instead of status patch rows.
9. Selected-import rebuild chunks no longer write, validate, or reset selected-import patch rows; ranged and full selected-import rebuilds write base rows and refresh final serving rows directly.
10. Full summary rebuild chunks and dirty incremental summary projection no longer consume status patch tables; they read serving rows plus judgment detail serving rows.
11. Rebuild request admission and missing-snapshot bootstrap range estimates no longer read status patch tables for prompt state; they use active project prompts.
12. Display, payload, title-search, queue, and posting full rebuild source reads no longer overlay `mart.review_selected_import_patch_v4`; they read selected-import base rows directly.
13. Full summary rebuilds no longer delete, publish, or refresh from `mart.review_article_summary_contribution_v4`; direct full rebuilds write only final serving rows, and request-associated reducers aggregate request-scoped contribution partials.
14. Requestless summary adoption has real DuckDB coverage for persisted `review_rebuild_request` and chunk `request_id` linkage, and the adoption SQL uses explicit `now()` timestamps in conflict updates.
15. Legacy V4 runtime patch-table cleanup and promotion compaction hooks have been removed from retention, selected-import rebuild reset, and snapshot promotion; retention now only cleans active serving/base tables protected by active, last-known-good, and pinned snapshots.
16. Runtime summary projection no longer reads, writes, deletes, repairs, retains, or startup-probes `mart.review_article_summary_contribution_v4`; dirty summary projection replaces final count/facet serving rows from serving/detail-derived source rows, while request-scoped contribution partials remain only for bounded summary rebuild finalization.

## Live Gate Blocker - July 4 Summary Finalization RSS

- Project: `d03fe24a-cfcf-41ed-b09f-7b554a393d80`
- Live stack: `FORSKA_DEV_SERVER_WATCH_ACTION=restart bun run dev:server`
- Before/after 60s: progress timestamps advanced from `2026-07-04 10:43:40.14394+02` to `2026-07-04 10:44:40.401138+02`, but pending/rebuild counts also grew while 9 chunks remained running/expired.
- Failure: the maintenance DuckDB owner reached about `14.45GB` RSS, peak `14.64GB`, then exited with Bun `panic: A C++ exception occurred`; the stack restarted maintenance and reported owner heartbeat failure while down.
- Fix applied: request-associated summary partial finalization no longer runs request-wide partial aggregations. It reduces partial rows into accumulator rows by bounded `chunk_id` batches, atomically deleting reduced source chunk rows before final serving rows are written from the accumulator.
- Follow-up failure: `bun run test:playwright` later timed out in `tests/e2e/covidenceReviewFlow.spec.ts` because completed summary chunks failed request finalization with `Binder Error: Table "review_article_summary_rebuild_partial_v4" does not have a column named "current_timestamp"` in the accumulator `ON CONFLICT` update.
- Follow-up fix: the accumulator conflict update now uses an explicit DuckDB timestamp function, and `reviewServingSummaryProjector.test.ts` has DuckDB-backed coverage for conflicting partial chunks reducing through finalization.
- Remaining gate status: focused regressions and the Covidence Playwright flow passed; the required live current-DB progress gate must be rerun before PR because the previous live gate exposed the RSS blocker.

## Deferred Future Work

The next work should happen only after the listed prerequisites are met:

1. Complete direct final-table snapshot build.
Implemented prerequisite: request-associated chunked full summary rebuilds now stage range partials and reduce them during completed-request finalization, with tests covering partial writes and reducer SQL. Requestless ranged summary chunks are adopted into that request finalization path. Full summary rebuild source rows now come from rebuilt serving/detail tables instead of status patch tables, finalization aggregates request-scoped contribution partials without writing the main contribution table, and dirty summary projection now directly recomputes final count/facet serving rows from serving/detail rows instead of relying on the main contribution ledger. Rebuild LLM and human status chunks now avoid status patch rows and use direct serving updates; queue rebuilds and rebuild request admission no longer consume status patch rows. Selected-import rebuild chunks now write base rows directly with SQL-native statements and refresh final serving rows directly instead of emitting or resetting selected-import patch rows, and direct rebuild readers no longer overlay selected-import patch rows. Dirty incremental projectors now avoid runtime patch-table reads/writes while preserving acknowledgement, manifest, watermark, and active/candidate semantics through direct table updates.
2. Remaining high-fanout JS materialization removal.
Implemented prerequisite: residual `posting` contribution diff/stat work no longer uses posting summary contribution rows; full posting writes remain set-based and incremental stats derive from serving-table counts. Judgment payload rebuilds and dirty incremental payload updates now use SQL-native detail-row writes and no longer materialize LLM/human payload source rows or writer records in JS; dirty incremental updates keep the writer transaction for acknowledgements, projection manifests, and watermark advancement only. Selected-import article-range rebuild chunks now use SQL-native base-row writes and no longer materialize selected-import rows or writer records in JS. Remaining prerequisite: collect current timing diagnostics after the landed slices and design SQL-native or staged paths for other measured hotspots.
3. Runtime presplitting removal.
Implemented: admission-time presplitting is the normal rebuild chunking path. Legacy rows and non-OOM misestimated chunks now execute directly instead of splitting at runtime for exceeding an input-row budget; DuckDB OOM splitting remains available where range splitting is supported.
4. Reader/transform parallelism.
Implemented first slice: the generic compatible fallback can prepare already-preclaimed chunks concurrently, bounded by `rebuildChunkBatchSize` and the effective RSS cap, then writes prepared outputs sequentially through the existing writer lane. Audited component-specific requestless range batches are SQL-native multi-range writer paths without a separate JS reader/transform phase, so they remain unchanged. Remaining prerequisite: identify a real component hotspot with separable JS preparation after future diagnostics before enabling component-specific preparation.
5. Set-based multi-chunk writer.
Prerequisites: prove range-disjointness and table compatibility, add conflict/parity tests, and batch chunks into one serialized transaction before considering writer concurrency.
6. Controlled multi-writer execution.
Production rebuild writes remain blocked behind evidence. The service now has an opt-in `FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED=true` append-transaction primitive for future disjoint-writer experiments, but rebuild chunks must not use it until stable live benchmark data, write-conflict tests, and memory-spill tests prove the specific component/table/range shape is safe and faster than the serialized multi-range writer.

## Historical Evidence - Archived June 30/July 1 Observations

The observations below are historical evidence from before the PR #108 safe slice merged. They are preserved to explain why the plan exists, but they should not be read as the current implementation state.

Observed request from June 30:

- Project: `d03fe24a-cfcf-41ed-b09f-7b554a393d80`
- Request: `rebuild:06b41de63a109055af3a953938c60bb4`
- Created/admitted: `2026-06-30 09:52:16+02`
- Snapshot at `2026-06-30 11:25+02`: admitted, not completed.
- Completed chunks: `560`
- Pending chunks: `50` (`posting` 40, `summary` 10)
- Project scope size: `18,784` articles

Observed phase windows from chunk `started_at`/`completed_at`:

| Component              | Completed | Pending | First Start | Last Complete |                  Wall Time |
| ---------------------- | --------: | ------: | ----------- | ------------- | -------------------------: |
| `projectScope`         |        60 |       0 | 09:53:14    | 09:53:21      |                         7s |
| `selectedImport`       |        60 |       0 | 09:58:23    | 09:59:21      |                        58s |
| `judgmentInputContent` |        60 |       0 | 09:59:23    | 10:14:39      |                    15m 16s |
| `display`              |        60 |       0 | 10:14:56    | 10:21:48      |                     6m 52s |
| `llmStatus`            |        60 |       0 | 10:21:57    | 10:27:21      |                     5m 24s |
| `humanStatus`          |        60 |       0 | 10:27:26    | 10:34:12      |                     6m 45s |
| `queue`                |        60 |       0 | 10:34:20    | 10:45:33      |                    11m 12s |
| `search`               |        60 |       0 | 10:45:41    | 11:06:36      |                    20m 55s |
| `payload`              |        60 |       0 | 11:06:58    | 11:07:45      |                        47s |
| `posting`              |        20 |      40 | 11:07:46    | 11:13:42      |              5m 55s so far |
| `summary`              |         0 |      10 | not started | not completed | blocked behind claim order |

Current row volumes for this project:

- `mart.review_title_search_serving_v4`: `473,146` rows
- `mart.review_article_judgment_detail_serving_v4`: `525,952` rows
- `mart.review_article_serving_v4`: `150,272` rows
- `mart.review_article_serving_payload_v4`: `37,568` rows
- `mart.review_unassessed_queue_serving_v4`: `90,482` rows
- `mart.review_article_filter_posting_serving_v4`: `352,640` rows
- `mart.review_article_filter_posting_patch_v4`: `176,320` rows
- `mart.review_article_summary_contribution_v4` for `posting`: `352,640` rows

Follow-up foreground repair evidence from July 1:

- Project: `4ec939b2-47bb-48dd-ad62-ad9f4b5acecf`
- The foreground priority and chunk-age fixes made the repair live: completed rebuild chunks advanced from `207` to `597` and `lastProgressedAt` stayed current.
- The repair was still too slow for the page: while rebuild chunks drained, the visible project refresh backlog grew to `4,686` pending / `4,676` queued and serving dirty work grew to `4,616` pending.
- Process RSS was roughly `7.1 GB`, and the diagnostics reported temp spill unavailable.

Historical verdict at the time: the path had started making progress, but it was doing too much serial and row-level work for a foreground missing-snapshot repair.

## Historical Bottlenecks From The Archived Evidence

These bottlenecks describe the June 30/July 1 implementation. Some are now fixed or partially fixed by PR #108 and earlier follow-ups; the current status table and remaining roadmap above are authoritative.

1. The rebuild is an artificial serial waterfall.

   `getNextClaimableReviewServingRebuildChunk` walks a fixed component order and returns one chunk. That order is stricter than the real dependency graph:
   - `display` waits behind all `judgmentInputContent`, although it only needs `projectScope` and `selectedImport`.
   - `search` waits behind `judgmentInputContent`, `display`, `llmStatus`, `humanStatus`, and `queue`, although it only needs `projectScope` and `selectedImport`.
   - `posting` waits behind `queue`, `search`, and `payload`, although its prerequisites are `projectScope`, `selectedImport`, `display`, `llmStatus`, and `humanStatus`.
   - `summary` waits behind `search`, `payload`, and `posting`, although it only needs `projectScope`, `selectedImport`, `llmStatus`, `humanStatus`, and `queue`.

   This delays user-visible readiness even when chunks are already logically claimable.

2. The worker processes one rebuild chunk per cycle.

   `runReviewServingProjectorWorkerCycle` claims and runs at most one rebuild chunk. If it completes a rebuild chunk, `shouldPrioritizeNextRebuildChunk` skips delta intake, normal projector work, and cleanup, then recurses immediately. This avoids unrelated work, but it also means 600+ rebuild chunks drain serially.

3. Heavy components materialize large result sets into JS.

   `search`, `judgmentInputContent`, `queue`, and especially `posting` query large row sets into JS arrays, map them into `ReviewServingProjectorRecord` objects, then send them to the writer. For the current project that means hundreds of thousands of rows per component.

4. The shared writer inserts one row at a time.

   `writeReviewServingProjectorComponent` reduces `records` sequentially, and `writeReviewServingProjectorRecord` runs a separate `INSERT ... ON CONFLICT` statement per record. For `search` this is roughly 473k individual upserts. For `posting`, the full rebuild path writes patch rows, serving rows, stats rows, and contribution rows, so one logical projection can fan out to roughly 880k row-level writes.

5. Full rebuild validation repeats expensive scans.

   `writeReviewServingRebuildChunkOutput` calls `validateOutput` after writing. For missing-snapshot rebuild chunks, `input.chunk.checksum` is usually null, so the checksum is not proving equivalence against a prior expected value. It still scans and `string_agg` hashes the chunk output just to store a checksum.

6. The chunk metrics schema is not populated.

   `duration_ms`, `actual_input_rows`, `actual_output_rows`, and byte counters are present but null for the current request. That makes the slow path harder to diagnose and prevents adaptive chunk sizing.

7. Root chunks are presplit at runtime.

   Each component starts with 10 root chunks, then most root chunks are marked completed as `input_row_budget_split` and create 50 child chunks. The split overhead is smaller than row writes, but it adds extra claim/transaction cycles and hides the real work from admission-time estimates.

## Parallelization Review

Parallelism can help, but only after the work units are made safer for DuckDB and memory. The live process was already around `7 GB` RSS with no temp spill, so blindly adding more projector workers would likely turn a slow repair into an unstable one.

### Work That Can Be Parallelized

1. Independent critical components after `selectedImport`.

   `display`, `judgmentInputContent`, `search`, and some status projections do not need to wait for every earlier component in a fixed array order. A DAG-aware scheduler can claim independent chunks in parallel or in alternating batches once their real prerequisites are complete.

2. Source query and transform phases.

   The read/transform part of heavy chunks can run concurrently if each task has a bounded row budget and the writer remains serialized. This is useful for `search`, `judgmentInputContent`, `queue`, and `posting`, but only after per-chunk diagnostics expose source-query time versus write time.

3. Set-based multi-chunk writes.

   The best first "parallel" shape is not multiple row-at-a-time writers. It is batching several compatible chunks into one `INSERT INTO ... SELECT ...` statement, grouped by component/table/range. DuckDB can parallelize set-based scans internally, and the app only holds one writer transaction.

4. Posting/filter fanout.

   `posting` is a natural partitioning candidate by filter key and article range. The safe version is per-partition staging followed by a serialized merge into serving tables. True concurrent writes to the same posting tables should wait until conflict and range-overlap tests prove it is safe.

5. Summary reduction.

   Summary work can be split into per-named-summary, per-prompt, or per-list-mode partial aggregates, then reduced into final count/facet rows. This avoids one giant serial summary pass and keeps per-task memory bounded.

6. Validation.

   Expected-checksum validation can be computed from the same staging data used for insertion, or parallelized by range and reduced. Missing-snapshot chunks with no expected checksum should usually skip the full checksum and store cheaper row-count/sample diagnostics instead.

### Work That Should Stay Serialized

- Snapshot promotion and manifest activation should remain one transaction.
- Candidate snapshot compaction should remain serialized until the full-rebuild path can avoid patch replay.
- Dirty-work acknowledgement and watermark advancement should preserve ordering/fencing.
- Writes to the same table and overlapping key range should use a single write lane unless range-disjointness is explicit.

### Parallelism Guardrails

- Add a single global writer lane first; allow concurrent readers/transforms to submit staged outputs to that lane.
- Cap parallel chunk execution by memory, not just CPU. Refuse parallel mode when temp spill is unavailable and RSS is above a configured threshold.
- Prefer component-specific SQL-native statements over JS arrays before adding concurrency.
- Track per-component rows/sec, memory delta, source-query ms, transform ms, write ms, and validation ms before tuning concurrency.
- Use a foreground budget for the active project: drain critical foreground chunks for a short TTL or chunk quota, then yield back to global fairness.

## Plan

### Phase 0 - Instrument Before Optimizing

Status: implemented for current rebuild executors.

- Implemented: chunk completion populates `duration_ms`, `actual_output_rows`, `actual_output_bytes`, `actual_payload_bytes`, and `diagnostics_json` from validation output in `writeReviewServingRebuildChunkOutput`; no-expected-checksum chunks record `validationMode: 'cheap-count'`.
- Implemented: chunk diagnostics now include `phaseTimings.writeOutputMs`, `phaseTimings.validationMs`, and `phaseTimings.totalBeforeCompletionMs`; worker progress logs include claim selection/update, heartbeat, execution, request finalization, DuckDB recycle, and Bun GC timings; `db:duck:inspect-review-serving-rebuild-timings` prints per-request phase timing summaries plus claimable pending chunks.
- Implemented: generic projector writes report input/deduped record counts, batch counts, and write ms by table. Posting rebuild chunks propagate source-query, diff-input transform, contribution-diff, record-transform, stats, delete-build, and writer timing diagnostics into chunk `diagnostics_json`. Summary rebuild chunks propagate source-query, contribution-transform, contribution-diff, summary-record-build, source/prior row counts, and writer diagnostics. Judgment-payload rebuild chunks propagate SQL-native writer and post-write count diagnostics. Display/payload, selected-import, title-search, queue, LLM status, and human status now expose source-query, transform, delete/reset or statement-build, writer, and post-write count timings where those phases exist. Worker batch completion diagnostics include compatible multi-range batch writer timing.

- Populate chunk `started_at`, `completed_at`, `duration_ms`, `actual_input_rows`, `actual_output_rows`, `actual_output_bytes`, `actual_payload_bytes`, and `diagnostics_json`.
- Split timing inside rebuild chunk execution into:
  - claim/heartbeat
  - source query
  - JS transform
  - delete/reset statements
  - record writes by table
  - validation/checksum
  - finalize/promote
- Add one rate-limited progress log with component, chunk id, split depth, rows written by table, and elapsed ms.
- Add a small operator query or script that prints per-request phase timings and pending claimable chunks.

Expected result: the next slow run points at exact cost centers instead of inferred timings.

### Phase 1 - Fix The Scheduler

Status: mostly implemented.

- Implemented: `rebuildChunkPrerequisitesByComponent`, critical-lane ordering, and `getRebuildChunkComponentPrerequisitePredicate` allow DAG-style claim readiness; tests cover `search` claimability after `projectScope`/`selectedImport`, posting prerequisites before queue/search/payload, and `summary` before `posting`.
- Implemented: foreground priority/age ordering and bounded foreground rebuild drain options (`foregroundRebuildDrainChunkBudget`, `foregroundRebuildDrainTtlMs`) keep critical foreground rebuild chunks moving without permanently starving other work.
- Implemented: rebuild chunks now persist first-class `critical`/`bulk` workload classes in `workload_class`; claim ordering uses the durable class and falls back to component-derived criticality for old rows.
- Implemented: maintenance defaults now run guarded two-chunk serial rebuild batches via `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE=2`, with explicit env overrides still available for single-chunk operation.

- Replace fixed `rebuildChunkClaimComponentOrder` selection with a DAG-aware claim query:
  - only claim chunks whose prerequisites are complete,
  - order by explicit critical-path priority and age,
  - do not wait for unrelated earlier components.
- Make the critical/bulk distinction first-class:
  - `critical`: enough rows and counts to make the current review page usable.
  - `bulk`: expensive secondary projections such as full posting/search rebuilds and optional filter fanout.
- Give the active foreground project a bounded drain budget so a user-opened missing-snapshot repair does not lose the worker after every chunk.
- Initial critical-path priority:
  - `projectScope`
  - `selectedImport`
  - `display`
  - `judgmentInputContent`
  - `llmStatus`
  - `humanStatus`
  - `queue`
  - `summary`
  - `payload`
  - `search`
  - `posting`
- Add a test proving `search` is claimable immediately after `selectedImport`, `posting` is claimable before `queue/search/payload`, and `summary` is claimable before `posting`.
- Consider two queues:
  - `critical`: minimum chunks needed to make the page usable.
  - `bulk`: expensive secondary projections such as full posting/search rebuilds.

Expected result: even before query optimization, the page reaches a useful state earlier and independent components do not block each other by array order.

### Phase 2 - Batch Or SQL-Native Writes

Status: mostly implemented.

- Implemented: the generic writer groups records by table/key/shape, dedupes by primary key, and writes `VALUES` batches of 250 instead of one upsert per record.
- Implemented: `search` rebuild uses `writeReviewServingTitleSearchRebuildRows` with SQL-native delete plus `INSERT INTO ... SELECT ... ON CONFLICT`; `queue` rebuild uses `writeReviewServingQueueRebuildRows` similarly.
- Implemented: full posting rebuilds now build serving rows with a set-based `INSERT INTO ... SELECT ... ON CONFLICT` statement and omit serving rows plus posting contribution rows from generic projector record writes. Posting summary contribution state is no longer written in full rebuilds or read for incremental stats; incremental stats derive from serving-table counts plus changed rows.
- Implemented: `judgmentInputContent`/payload rebuild chunks and dirty incremental payload updates now delete and rewrite scoped detail rows with SQL-native `INSERT INTO ... SELECT` statements, build payload JSON in DuckDB, count written rows after insert, and report zero JS materialized source/record rows. Dirty incremental updates preserve dirty-work acknowledgements, projection manifests, and watermark advancement through the shared writer transaction without generic writer records.
- Implemented: selected-import article-range rebuild chunks now delete/insert scoped `app.review_selected_article_import_v4` rows with SQL-native statements, refresh `mart.review_article_serving_v4` rows directly from selected-import base rows, and use a post-write count, while the cursor-based selected-import batch path remains for full non-ranged base drains before the direct serving refresh.
- Still pending: complete SQL-native/source-staged paths for any lower-volume components where diagnostics prove remaining JS materialization is still meaningful; broader tests for component-specific SQL-native rebuild writers remain pending.

- Add a bulk writer path to `writeReviewServingProjectorComponent`:
  - group records by table and conflict key,
  - write in `VALUES` batches or temporary tables,
  - perform one `INSERT ... SELECT ... ON CONFLICT` per batch/table instead of per record.
- Prefer component-specific `INSERT INTO ... SELECT ...` paths for the heaviest components. A generic batch writer is useful as a fallback, but the fastest path for `search`, `judgmentInputContent`, `queue`, and `posting` is to keep the computation inside DuckDB and avoid building hundreds of thousands of JS objects.
- Start with `search` and `judgmentInputContent`; they are straightforward record writes and dominated the observed run.
- Move `posting` to SQL-native staging:
  - compute contribution rows in DuckDB,
  - compute diffs and stats in DuckDB,
  - upsert serving, patch, stats, and contribution rows with set-based statements.
- Keep the row-at-a-time writer as a fallback for low-volume components until tests cover the bulk path.

Expected result: hundreds of thousands of statements collapse into tens or hundreds of statements.

### Phase 3 - Add A Full-Rebuild Fast Path

Status: complete for production-safe single-writer rebuild execution.

- Implemented: `missingReviewServingSnapshot` requests can bootstrap a candidate snapshot, projection identity manifests, and explicit rebuild chunks rather than only replaying dirty work.
- Implemented: several rebuild executors write bounded base/candidate rows directly by article range.
- Implemented: full posting rebuild chunks skip `mart.review_article_filter_posting_patch_v4` writes and now write only serving/stat state needed by the final candidate snapshot. Summary article-range chunks no longer recompute global filter options; completed-request finalization refreshes them once for each summary projection.
- Implemented: full posting rebuilds write serving rows with set-based statements instead of the generic projector record writer and no longer write/delete posting summary contribution state; unchunked full summary rebuilds delete and rewrite final count/facet serving rows directly without summary contribution state; request-associated chunked full summary rebuilds write `mart.review_article_summary_rebuild_partial_v4` rows and reduce them to final count/facet serving rows during completed-request finalization; full summary rebuild source rows now read rebuilt serving/detail rows instead of status patch rows; summary finalization now aggregates request-scoped contribution partials instead of writing or reading `mart.review_article_summary_contribution_v4`; fresh candidate snapshots with no selected-import patch watermark skip candidate patch-compaction scans; rebuild `llmStatus` and `humanStatus` chunks update serving rows without writing or reading status patch rows; queue rebuild chunks derive rows directly from source judgment/human judgment tables; rebuild request admission reads active project prompts instead of status patch rows; and full rebuild display/payload/title-search/queue/posting selected-import reads come from selected-import base rows without patch overlays.
- Implemented: dirty incremental legacy patch support has been removed from runtime projectors and retention. Dirty projectors now update direct serving/base/detail tables while retaining acknowledgement, manifest, watermark, and active/candidate semantics; retention no longer scans, compacts, or deletes legacy patch tables.

- Treat `missingReviewServingSnapshot` as a snapshot build, not as an incremental patch replay.
- Implement this before optimizing all incremental dirty-work fanout. The live foreground repair showed thousands of serving dirty-work rows becoming visible while rebuild chunks were still moving, which is the wrong shape for a page-open repair.
- For full rebuilds, write final candidate serving tables directly by chunk/range.
- Avoid writing patch and contribution rows that only exist to support incremental updates when the whole snapshot is being built from scratch.
- Recompute summary/count state from the final serving tables once per snapshot or per component-range, not per article-row mutation.
- Keep incremental dirty-work paths unchanged until the full-rebuild path is stable.

Expected result: a full missing-snapshot rebuild does less total work than an incremental projector replay over every article.

### Phase 4 - Make Validation Proportional

Status: mostly implemented.

- Implemented: chunks with `checksum !== null` keep strict `string_agg` checksum validation; chunks with `checksum === null` use cheap count validation and store `validationMode: 'cheap-count'`.
- Implemented: `FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION=true` forces full checksum diagnostics for chunks without expected checksums and records `validationMode: 'debug-strict-checksum'`.
- Implemented: full posting rebuild chunks can return a lightweight post-write serving count from `projectReviewServingFilterPostings`; `writeReviewServingRebuildChunkOutput` accepts that validation result and avoids the generic output-table checksum scan when exactly one posting snapshot result provides it.
- Still pending: extend source/staging checksum reuse if future strict-validation bottlenecks appear outside the completed posting full-rebuild path.

- If a chunk has an expected checksum, keep strict checksum validation.
- If a chunk has no expected checksum, skip full `string_agg` checksum by default and store cheaper diagnostics:
  - row count,
  - optional sampled hash,
  - table-specific consistency checks.
- Add a debug/CI mode that computes full checksums for targeted tests and parity runs.
- Where checksums remain necessary, compute them from the same staging query used for insertion instead of rescanning the written table.

Expected result: rebuild validation no longer duplicates the most expensive component scans.

### Phase 5 - Rework Chunk Admission

Status: implemented.

- Implemented: default rebuild admission can presplit supported single-component rebuilds by estimated input rows; missing-snapshot bootstrap can compute article ranges and admit explicit bootstrap chunks up front.
- Implemented: default single-component rebuild admission now uses per-component input-row budgets for high-fanout components such as status, posting, summary, queue, payload, display, selected import, project scope, and search instead of the old search-only rule.
- Implemented: admitted chunks carry estimate/budget fields and admission diagnostics such as `admissionPresplit`.
- Implemented: runtime `input_row_budget` presplitting has been removed. Old rows and non-OOM misestimated chunks execute directly; unexpected DuckDB OOM still falls back to range splitting where supported.

- Presplit at admission time using component-specific target rows:
  - `search`: target token rows
  - `judgmentInputContent`: target detail rows
  - `posting`: target posting contribution rows
  - `queue`: target queue rows
- Stop creating root chunks that only split and never do projection work.
- Tune chunk sizes after bulk writes; larger chunks may become better once per-record statement overhead is gone.
- Record actual rows per chunk and feed that back into future admission estimates.

Expected result: fewer administrative cycles and chunk sizes that reflect real output cost.

### Phase 6 - Controlled Parallelism

Status: partially implemented.

- Implemented: `runReviewServingProjectorWorkerCycle` supports a configurable `rebuildChunkBatchSize` for claiming/running several rebuild chunks in one wake. The maintenance heartbeat wires it to `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE`, defaulting to 2. `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES` defaults to an auto system-memory-derived cap and limits multi-chunk batching back to one chunk once process RSS reaches the cap; explicit env values can still force size 1 or cap 0/off. Background multi-chunk batches now preclaim only requestless same-component, same-projection, range-disjoint chunks before serial execution; foreground/request chunks keep single-claim behavior so reader-yield semantics stay intact, and summary chunks are excluded from component batching because their request finalization path owns reduction. Compatible ranged fresh `projectScope` chunks and ranged `selectedImport`, `display`, `payload`, `search`, `llmStatus`, `humanStatus`, `queue`, `judgmentInputContent`, and `posting` chunks now use batch writers that submit all preclaimed ranges through one serialized projector-writer transaction before validating/completing each manifest. Batch-writer exceptions fail all preclaimed chunks.
- Implemented: the generic compatible fallback now prepares already-preclaimed chunks concurrently with bounded `Promise.all` over the effective preclaimed batch only, then runs each prepared write sequentially. Focused tests cover concurrent preparation, serialized writes, and failing the not-yet-completed prepared chunk on writer failure.
- Audited and unchanged: compatible `projectScope`, `selectedImport`, `display`, `payload`, `search`, `llmStatus`, `humanStatus`, `queue`, `judgmentInputContent`, and `posting` component batches are SQL-native multi-range writes with no separable JS preparation phase.
- Implemented service primitive only: DuckDB exposes opt-in append-lane transactions behind `FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED=true`. The lane keeps the normal `transaction` API on the serialized main queue, collapses append transactions back to the main queue on low-memory runtimes through the existing `serializeConcurrentWork` guardrail, observes append barriers, records workload diagnostics when a workload context is supplied, and rolls back a failed append transaction before the lane accepts the next transaction.
- Blocked for production rebuild chunks: controlled multi-writer execution still needs component-specific live benchmark evidence, write-conflict coverage, and memory-spill coverage. Until that evidence exists, rebuild chunks stay on serialized multi-range writer transactions.

- After bulk writes and scheduler fixes, test controlled parallelism:
  - claim multiple independent chunks per wake,
  - cap concurrency per component,
  - cap global write concurrency to what DuckDB handles safely,
  - avoid concurrent writes to the same table/range unless conflict tests prove it is safe.
- Start with read/transform parallelism plus a serialized writer lane.
- Then test set-based multi-chunk writes, where one transaction handles several range-disjoint chunks.
- Only after those are stable, test multiple writer transactions against disjoint tables or disjoint key ranges.
- Prefer "batch many chunks into one set-based write" before adding true concurrent writers.

Expected result: parallelism improves CPU/query throughput without turning DuckDB into a write-lock bottleneck.

## Future Implementation Order

1. Keep the missing-snapshot final-table build on direct sources. Selected import is direct for ranged and full rebuild chunks; rebuild LLM/human status patch writes/reads are removed; queue rebuild and rebuild request admission no longer consume status patch rows; full summary rebuild source rows read serving/detail tables; full summary finalization no longer writes or reads the main contribution table; and requestless ranged summary chunks use deterministic internal requests instead of the rejected legacy path.
2. Dirty incremental judgment payload JS materialization has been removed; continue with other component-specific SQL-native/staged paths only where current diagnostics prove remaining JS materialization is still meaningful.
3. Runtime input-budget presplitting has been removed; keep future chunk-size work in admission or DuckDB OOM fallback paths.
4. Extend bounded reader/transform parallelism only where a real component has separable JS preparation; keep memory/RSS guardrails and the serialized writer lane.
5. Keep set-based multi-chunk writers limited to proven compatible range-disjoint chunks.
6. Use the append-transaction primitive only for explicit experiments after range-disjointness, write-conflict, memory-spill, and benchmark tests are stable; production rebuild chunks stay single-writer until those gates pass.

## Quality Gates

- `bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts`
- `bun test src/server/workers/reviewServingProjectorWorker.test.ts`
- `bun test src/server/reviewServing/reviewServingProjectorWriter.test.ts`
- Component-specific tests for any migrated projector:
  - `reviewServingTitleSearchProjector.test.ts`
  - `reviewServingJudgmentPayloadProjector.test.ts`
  - `reviewServingQueueProjector.test.ts`
  - `reviewServingFilterPostingProjector.test.ts`
- Add a current-DB or fixture benchmark gate that records:
  - total rebuild wall time,
  - phase wall time,
  - rows/sec by table,
  - max RSS/duckdb memory,
  - final active snapshot validation.
- Performance target for this project shape: full missing-snapshot rebuild under 10 minutes on the local M4-class dev machine, then tighten after the bulk writer lands.

## Commands Run During Investigation

Current judgment-payload SQL-native rebuild verification:

- `bun test src/server/reviewServing/reviewServingJudgmentPayloadProjector.test.ts`
- `bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingLlmStatusProjector.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.test.ts`
- `bun run lint`
- `duckdb :memory: -c "SELECT json_object('assessments', CASE WHEN TRUE THEN [] ELSE [json_object('id', 'a')] END, 'payloadReference', json_object('kind', 'placeholder'), 'answerArray', CASE WHEN 'x' IS NULL THEN NULL ELSE ['x'] END)"`

Current dirty incremental judgment-payload SQL-native verification:

- `bun test src/server/reviewServing/reviewServingJudgmentPayloadProjector.test.ts`
- `bun test src/server/reviewServing/reviewServingJudgmentPayloadProjector.test.ts src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts`
- `bun run lint`
- `bun run build`

Current selected-import SQL-native article-range verification:

- `bun test src/server/reviewServing/reviewServingSelectedImportProjector.test.ts`
- `bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingLlmStatusProjector.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.test.ts`
- `bun run lint`

Current selected-import direct final/base serving-table cutover verification:

- `bun test src/server/reviewServing/reviewServingSelectedImportProjector.test.ts src/server/workers/reviewServingProjectorWorker.test.ts`
- `bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingLlmStatusProjector.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.test.ts`
- `bun run lint`

Current July 4 summary finalization fix verification:

- `bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts`
- `bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingLlmStatusProjector.test.ts src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.test.ts`
- `bun run lint`
- `duckdb :memory: -c "CREATE TABLE t (...); INSERT ... ON CONFLICT(...) DO UPDATE SET count_value = CASE ...; SELECT count_value FROM t;"`

Current Phase 3 slice verification:

- `bun test src/server/reviewServing/reviewServingLlmStatusProjector.test.ts`
- `bun test src/server/reviewServing/reviewServingHumanStatusProjector.test.ts`
- `bun test src/server/workers/reviewServingProjectorWorker.test.ts`

Current legacy patch cleanup removal verification:

- `bun test src/server/reviewServing/reviewServingRetentionService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts`
- `bun test src/server/reviewServing/reviewServingPhase5BStaticGuards.test.ts src/server/reviewServing/reviewServingPhase3Integration.test.ts src/server/utils/duckdbServiceReload.test.ts`

Current summary contribution ledger removal verification:

- `bun test src/server/reviewServing/reviewServingContributionService.test.ts src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingProjectorWriter.test.ts src/server/reviewServing/reviewServingRetentionService.test.ts src/server/reviewServing/reviewServingInvalidationRegistry.test.ts src/server/reviewServing/reviewServingPhase3Integration.test.ts src/server/reviewServing/reviewServingFilterPostingProjector.test.ts src/server/utils/duckdbServiceReload.test.ts`

Historical investigation commands:

- `ps -axo pid,ppid,etime,pcpu,pmem,rss,command | rg -i 'reviewServing|projector|forska|bun|node|duckdb|vite|next'`
- `lsof -nP -iTCP:3001 -iTCP:3002 -iTCP:5173 -sTCP:LISTEN`
- `tail -200 logs/runtime/primary/maintenance-worker-server-2026-06-30.jsonl`
- `bun run db:query:snapshot -- --sql="..."`
- `duckdb -readonly "/Users/fredrik/Library/Application Support/Forska/runtime/primary/forska.duckdb" -c "SET memory_limit='20GB'; ..."`
- Source reads:
  - `src/server/reviewServing/reviewServingChunkManifestRepository.ts`
  - `src/server/workers/reviewServingProjectorWorker.ts`
  - `src/server/reviewServing/reviewServingProjectorWriter.ts`
  - `src/server/reviewServing/reviewServingTitleSearchProjector.ts`
  - `src/server/reviewServing/reviewServingFilterPostingProjector.ts`
  - `src/server/reviewServing/reviewServingJudgmentPayloadProjector.ts`
  - `src/server/reviewServing/reviewServingQueueProjector.ts`

Note: `bun run db:query:snapshot` was blocked by the owner-lease guard in some attempts, while no listener/process was visible by `lsof`/`ps`. I used read-only DuckDB CLI queries with an explicit memory cap for investigation only.
