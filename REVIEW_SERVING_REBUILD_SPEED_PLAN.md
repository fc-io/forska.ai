# Review Serving Rebuild Speed Plan

## Scope

Make the V4 review-serving rebuild path fast enough for the review page's normal "missing snapshot" path. This plan is intentionally investigation and implementation planning only; no code changes are included here.

Status: investigation and implementation plan.

## Current Evidence

Latest observed request:

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

## Why It Is Slow

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

## Plan

### Phase 0 - Instrument Before Optimizing

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

- Replace fixed `rebuildChunkClaimComponentOrder` selection with a DAG-aware claim query:
  - only claim chunks whose prerequisites are complete,
  - order by explicit critical-path priority and age,
  - do not wait for unrelated earlier components.
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

- Add a bulk writer path to `writeReviewServingProjectorComponent`:
  - group records by table and conflict key,
  - write in `VALUES` batches or temporary tables,
  - perform one `INSERT ... SELECT ... ON CONFLICT` per batch/table instead of per record.
- Start with `search` and `judgmentInputContent`; they are straightforward record writes and dominated the observed run.
- Move `posting` to SQL-native staging:
  - compute contribution rows in DuckDB,
  - compute diffs and stats in DuckDB,
  - upsert serving, patch, stats, and contribution rows with set-based statements.
- Keep the row-at-a-time writer as a fallback for low-volume components until tests cover the bulk path.

Expected result: hundreds of thousands of statements collapse into tens or hundreds of statements.

### Phase 3 - Add A Full-Rebuild Fast Path

- Treat `missingReviewServingSnapshot` as a snapshot build, not as an incremental patch replay.
- For full rebuilds, write final candidate serving tables directly by chunk/range.
- Avoid writing patch and contribution rows that only exist to support incremental updates when the whole snapshot is being built from scratch.
- Recompute summary/count state from the final serving tables once per snapshot or per component-range, not per article-row mutation.
- Keep incremental dirty-work paths unchanged until the full-rebuild path is stable.

Expected result: a full missing-snapshot rebuild does less total work than an incremental projector replay over every article.

### Phase 4 - Make Validation Proportional

- If a chunk has an expected checksum, keep strict checksum validation.
- If a chunk has no expected checksum, skip full `string_agg` checksum by default and store cheaper diagnostics:
  - row count,
  - optional sampled hash,
  - table-specific consistency checks.
- Add a debug/CI mode that computes full checksums for targeted tests and parity runs.
- Where checksums remain necessary, compute them from the same staging query used for insertion instead of rescanning the written table.

Expected result: rebuild validation no longer duplicates the most expensive component scans.

### Phase 5 - Rework Chunk Admission

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

- After bulk writes and scheduler fixes, test controlled parallelism:
  - claim multiple independent chunks per wake,
  - cap concurrency per component,
  - cap global write concurrency to what DuckDB handles safely,
  - avoid concurrent writes to the same table/range unless conflict tests prove it is safe.
- Prefer "batch many chunks into one set-based write" before adding true concurrent writers.

Expected result: parallelism improves CPU/query throughput without turning DuckDB into a write-lock bottleneck.

## Recommended Implementation Order

1. Instrument chunk timings and row counts.
2. Fix claim order to use actual DAG readiness instead of fixed component order.
3. Add bulk writer support and migrate `search`.
4. Migrate `judgmentInputContent` and `queue` to bulk writes.
5. Add SQL-native/full-rebuild fast path for `posting`.
6. Skip or cheapen checksum validation for no-expected-checksum rebuild chunks.
7. Move presplitting into admission and tune chunk sizes.
8. Add controlled multi-chunk execution only after the set-based path is stable.

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
