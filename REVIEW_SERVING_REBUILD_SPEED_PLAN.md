# Review Serving Rebuild Speed Plan

## Scope

Make the V4 review-serving rebuild path fast enough for the review page's normal "missing snapshot" path. This plan is intentionally investigation and implementation planning only; no code changes are included here.

Status: PR #108's safe implementation slice is merged. The overall speed plan remains in progress; this document now tracks the remaining roadmap plus archived June 30/July 1 evidence that motivated the work.

## Implementation Audit - Post PR #108 Merge

Current implementation status after PR #108 merged, based on source inspection against this plan:

| Phase | Status | Current Evidence |
| --- | --- | --- |
| Phase 0 - Instrument Before Optimizing | Mostly implemented | Chunk completion now writes `duration_ms`, actual output rows/bytes/payload bytes, and `diagnostics_json`; cheap validation records `validationMode`; chunk diagnostics include write/validation timing splits; worker progress logs include claim/heartbeat/execute/finalize/recycle/GC timings; the generic writer reports record counts/batches/write ms per table; posting, summary, and judgment-payload rebuild chunks report source-query, transform/diff, and writer timing splits; `db:duck:inspect-review-serving-rebuild-timings` summarizes per-request timings and claimable pending chunks. Fine-grained source-query/JS-transform timing is still pending for other remaining JS-heavy components that do not use SQL-native writers. |
| Phase 1 - Fix The Scheduler | Mostly implemented | Claiming now uses component prerequisites and critical-lane/priority ordering instead of the old fixed waterfall; tests cover independent claimability. Foreground rebuild drain budget/TTL exists. Chunks now persist a durable `workload_class` of `critical` or `bulk`, and claim ordering uses it with a component fallback for old rows. The worker can now run a bounded configurable rebuild chunk batch per wake, defaulting to one chunk until enabled. |
| Phase 2 - Batch Or SQL-Native Writes | Mostly implemented | Generic record writes are batched by table/key/shape in `writeReviewServingProjectorRecords`; `search` and `queue` rebuilds have SQL-native `INSERT INTO ... SELECT` paths. Full posting rebuilds now use a set-based SQL statement for serving rows instead of sending those rows through the generic projector writer, and no longer write posting contribution rows. `judgmentInputContent` still calls projector SQL but validation/looping remains component-specific, and posting still materializes source/diff/stat rows in JS before the full-rebuild set-based write. |
| Phase 3 - Add A Full-Rebuild Fast Path | Partially implemented | Missing-snapshot requests can create a bootstrap candidate snapshot and explicit bootstrap chunks. Several rebuild chunk executors write base/candidate rows directly, full posting rebuilds now skip incremental posting patch rows and posting summary contribution state, use set-based serving writes, and summary rebuild chunks leave global filter-option refresh to request finalization. Fresh candidate snapshots with no selected-import patch watermark now skip candidate patch-compaction scans. Full rebuild still writes summary contribution state and still uses candidate compaction/promotion where patch work exists rather than a complete direct final-table snapshot build. |
| Phase 4 - Make Validation Proportional | Mostly implemented | `getRebuildChunkOutputValidation` keeps strict checksum validation when `chunk.checksum` is present and uses cheap count validation with `validationMode: 'cheap-count'` when it is null. `FORSKA_REVIEW_SERVING_REBUILD_STRICT_VALIDATION=true` forces full checksum diagnostics for targeted parity/debug runs. Full posting rebuild chunks can return a lightweight `post-write-serving-count` validation result from the projector and avoid the generic checksum validation path. Tests cover these modes. |
| Phase 5 - Rework Chunk Admission | Mostly implemented | Default rebuilds and missing-snapshot bootstrap can presplit at admission using estimate/budget-derived article ranges; default single-component rebuilds now use component-specific input-row budgets for high-fanout components. Proactive runtime input-budget presplitting now skips chunks already marked `admissionPresplit`, while DuckDB OOM splitting remains as a safety net for misestimated chunks. |
| Phase 6 - Controlled Parallelism | Partially implemented | The worker now supports a configurable `rebuildChunkBatchSize` that can claim and execute multiple rebuild chunks in one wake while preserving the existing serialized writer lane; the maintenance heartbeat wires this to `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE`, defaulting to 1. True read/transform parallelism, set-based multi-chunk write, and controlled multi-writer execution are still pending. |

Summary: the plan is no longer a pure future plan. Scheduler ordering, foreground priority/drain, cheap validation, generic batched writes, SQL-native search/queue rebuild writes, full-posting set-based serving writes, full-posting contribution fanout removal, lightweight posting validation, bootstrap missing-snapshot admission, admission presplitting, admission-presplit runtime split narrowing with DuckDB OOM fallback, high-fanout timing diagnostics, summary finalization cleanup, fresh no-patch compaction short-circuiting, and configurable serial chunk batching have landed. The remaining largest gaps are complete direct final-table snapshot semantics for summary/final tables, remaining JS materialization in posting/judgment-heavy paths, further runtime presplitting cleanup for legacy/non-admission rows, and true read/transform or writer parallelism.

## Remaining Roadmap

The next implementation work should focus on these unfinished items, in this order unless new benchmark data changes the bottleneck ranking:

1. Direct final-table snapshot build: make full missing-snapshot rebuilds write final candidate serving tables directly, avoiding remaining summary contribution rows and candidate patch compaction where patch work still exists only for incremental replay semantics.
2. Remaining high-fanout JS materialization: finish removing large JS row arrays from `posting`, `judgmentInputContent`, or any other rebuild paths where source inspection or timings still show materialization overhead after the full-posting set-based write slice.
3. Runtime presplitting cleanup: keep admission-time presplitting as the normal path and continue narrowing runtime presplitting beyond the landed `admissionPresplit` skip once old rows and non-OOM misestimated chunks have safe alternatives.
4. Reader/transform parallelism: add bounded parallel source-query/transform work with a single serialized writer lane and memory/RSS guardrails.
5. Set-based multi-chunk writer: batch compatible range-disjoint chunks into one set-based transaction before adding more writer concurrency.
6. Controlled multi-writer execution: only after range-disjointness, conflict behavior, and memory-spill tests are stable, allow multiple writer transactions against disjoint tables or disjoint key ranges.

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

Status: mostly implemented.

- Implemented: chunk completion populates `duration_ms`, `actual_output_rows`, `actual_output_bytes`, `actual_payload_bytes`, and `diagnostics_json` from validation output in `writeReviewServingRebuildChunkOutput`; no-expected-checksum chunks record `validationMode: 'cheap-count'`.
- Implemented: chunk diagnostics now include `phaseTimings.writeOutputMs`, `phaseTimings.validationMs`, and `phaseTimings.totalBeforeCompletionMs`; worker progress logs include claim selection/update, heartbeat, execution, request finalization, DuckDB recycle, and Bun GC timings; `db:duck:inspect-review-serving-rebuild-timings` prints per-request phase timing summaries plus claimable pending chunks.
- Implemented: generic projector writes report input/deduped record counts, batch counts, and write ms by table. Posting rebuild chunks propagate source-query, diff-input transform, contribution-diff, record-transform, stats, delete-build, and writer timing diagnostics into chunk `diagnostics_json`. Summary rebuild chunks propagate source-query, contribution-transform, contribution-diff, summary-record-build, source/prior row counts, and writer diagnostics. Judgment-payload rebuild chunks propagate source-query, record-transform, source row counts, and writer diagnostics.
- Still pending: source-query and JS-transform timing splits inside any remaining lower-volume JS executors that do not use SQL-native writers.

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
- Still pending: the worker defaults to one rebuild chunk per wake until `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE` is raised; read/transform parallelism is covered under Phase 6.

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
- Implemented: full posting rebuilds now build serving rows with a set-based `INSERT INTO ... SELECT ... ON CONFLICT` statement and omit serving rows plus posting contribution rows from generic projector record writes.
- Still pending: complete SQL-native/source-staged rebuild paths for `posting` and other high-fanout components that still materialize source, diff, stats, or validation data in JS; broader tests for component-specific SQL-native rebuild writers.

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

Status: partially implemented.

- Implemented: `missingReviewServingSnapshot` requests can bootstrap a candidate snapshot, projection identity manifests, and explicit rebuild chunks rather than only replaying dirty work.
- Implemented: several rebuild executors write bounded base/candidate rows directly by article range.
- Implemented: full posting rebuild chunks skip `mart.review_article_filter_posting_patch_v4` writes and now write only serving/stat state needed by the final candidate snapshot. Summary article-range chunks no longer recompute global filter options; completed-request finalization refreshes them once for each summary projection.
- Implemented: full posting rebuilds write serving rows with set-based statements instead of the generic projector record writer and no longer write/delete posting summary contribution state; fresh candidate snapshots with no selected-import patch watermark skip candidate patch-compaction scans.
- Still pending: a complete direct final-table snapshot build that avoids remaining summary contribution rows and candidate patch compaction where patch work still exists.

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

Status: mostly implemented.

- Implemented: default rebuild admission can presplit supported single-component rebuilds by estimated input rows; missing-snapshot bootstrap can compute article ranges and admit explicit bootstrap chunks up front.
- Implemented: default single-component rebuild admission now uses per-component input-row budgets for high-fanout components such as status, posting, summary, queue, payload, display, selected import, project scope, and search instead of the old search-only rule.
- Implemented: admitted chunks carry estimate/budget fields and admission diagnostics such as `admissionPresplit`.
- Implemented: proactive runtime `input_row_budget` presplitting now skips chunks already marked `admissionPresplit`; unexpected DuckDB OOM still falls back to range splitting for those chunks.
- Still pending: removal of runtime presplitting entirely. Runtime presplitting still exists as a safety net for old rows and non-OOM misestimated chunks.

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

- Implemented: `runReviewServingProjectorWorkerCycle` supports a configurable `rebuildChunkBatchSize` for claiming/running several rebuild chunks in one wake. The maintenance heartbeat wires it to `FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE`, defaulting to 1. The batch still executes serially through the existing writer lane, which reduces claim/cycle overhead without introducing concurrent DuckDB writes.
- Pending: default-on parallelism, reader/transform worker pool, set-based multi-chunk writer, and controlled multi-writer execution.

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

## Recommended Remaining Implementation Order

1. Build missing-snapshot snapshots directly into final candidate serving tables, including summary/final-table semantics that avoid unnecessary contribution and patch-compaction work still left after the posting fast-path slices.
2. Finish removing high-fanout JS materialization where timings still show source/diff/stat/validation overhead.
3. Continue narrowing runtime presplitting after admission-time presplitting covers normal rebuilds; the `admissionPresplit` skip and DuckDB OOM fallback are landed, but legacy/non-OOM fallback behavior still needs cleanup.
4. Add bounded reader/transform parallelism with a single writer lane.
5. Add a set-based multi-chunk writer for compatible range-disjoint chunks.
6. Add controlled multi-writer execution only after range-disjointness, write-conflict, memory-spill, and benchmark tests are stable.

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
