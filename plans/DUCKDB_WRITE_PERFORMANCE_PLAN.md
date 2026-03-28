# DUCKDB_WRITE_PERFORMANCE_PLAN

## Scope reviewed

- `src/server/utils/duckdbService.ts`
- `src/server/services/appDatabaseService.ts`
- `src/server/services/getDuckdbMartRefreshService.ts`
- `src/server/services/articleImportStoreService.ts`
- `src/server/routes/ProjectsRoutes.ts`
- `src/server/routes/ComparisonProjectsRoutes.ts`
- `src/server/routes/PromptsRoutes.ts`
- `src/agent/judge/judgeStoreJudgment.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`

## Current read of the system

- The repo already has a solid baseline for safe embedded DuckDB writes:
  - one writer lease across processes
  - one serialized control queue for ordinary writes/transactions
  - one separate background queue for mart refresh work
  - separate append lanes for high-volume `app.judgment` inserts
- The main performance wins already present are:
  - batched `INSERT ... VALUES ... ON CONFLICT` in `articleImportStoreService.ts`
  - parallel append lanes in `appDatabaseService.ts`
  - batched mart rebuild SQL in `getDuckdbMartRefreshService.ts`
- The biggest remaining write-cost issues are mostly SQL shape and write amplification, not missing threads.

## Bottlenecks worth targeting first

- Most writes are still built as large escaped SQL strings.
  - That means repeated parse/plan work and lots of string allocation in JS.
- A lot of route logic still does row-by-row work inside transactions.
  - `ProjectsRoutes.ts`
  - `PromptsRoutes.ts`
  - `ComparisonProjectsRoutes.ts`
- `duckdbService.ts` splits multi-statement SQL strings at runtime and executes them statement-by-statement.
  - Good for simplicity.
  - Expensive on hot paths.
- `appendJudgments` is the only place that really uses a purpose-built fast path.
  - Other write-heavy paths still use the generic control lane.
- Mart refresh has deliberate safety, but it can do a lot of delete/reinsert work for project-level refreshes.
- A few write-heavy routes still have their own bespoke bulk-write logic instead of sharing the better service-layer path.

## Plan

### 1. Add real write-path instrumentation before changing behavior

Add metrics around:

- control queue wait time
- control transaction duration
- background queue wait time
- append lane queue depth and batch size
- statement count per request for write-heavy routes
- rows touched per write-heavy route
- checkpoint duration and WAL size before/after large write bursts

Use that to identify the top 3 write paths by:

- total time spent waiting for the control queue
- total rows rewritten
- total bytes of SQL text generated in JS

## 2. Create two explicit write APIs instead of one generic string path

Keep the existing generic API, but add specialized helpers for hot paths:

- `runStatementList(statements: string[])`
  - avoids repeated SQL splitting for callers that already have a statement array
- `appendRows(...)` / appender-style helper for pure append workloads
- `runPreparedBatch(...)` for repeated inserts/updates with the same shape

Rule:

- generic string SQL stays fine for admin/debug/rare routes
- hot write paths move onto explicit batch helpers

## 3. Expand the append-lane model only for append-only tables

Use the `appendJudgments` pattern as the model for other append-heavy writes, but only when the workload is truly append-only and idempotent.

Good candidates:

- judgment imports from `judgmentJobSqliteOutboxImport.ts`
- telemetry-like writes (`token_use`, `nvidia_smi`, status/event tables)

Not good candidates:

- project edits
- prompt merges
- multi-table canonical mutations
- mart refresh steps

## 4. Replace row-by-row route writes with staging-table diffs

For large edit flows, stop doing nested `SELECT` / `UPDATE` / `DELETE` loops from JS.

Preferred pattern:

- load request payload into a temp staging table
- compute `to_insert`, `to_update`, `to_delete` in SQL
- apply changes in a small fixed number of set-based statements

Target files:

- `ProjectsRoutes.ts`
- `PromptsRoutes.ts`
- `ComparisonProjectsRoutes.ts`

This should reduce:

- JS string-building cost
- round-trips inside one transaction
- transaction open time on the control connection

## 5. Generalize the `articleImportStoreService.ts` batching style

`articleImportStoreService.ts` is already closer to the desired shape:

- one transaction
- batched article upsert
- batched link insert
- refresh queued after commit

Use that as the reference style for other canonical write paths.

## 6. Unify duplicated import/batch-upsert write paths

A specific cleanup worth doing early:

- make `/api/articles/batch-upsert` call the same service-layer article import/batch-upsert flow as `articleImportStoreService.ts`
- keep one canonical implementation for:
  - route creation/lookup
  - article upsert shape
  - article/import-route linking
  - refresh queue behavior

That reduces both code drift and write-path divergence.

## 7. Remove obvious query-plan hotspots in write-adjacent flows

A concrete example from the current codebase:

- `humanAssessmentRoutesPostInit.ts` uses `ORDER BY RANDOM()` to allocate the next article

That will become expensive as project scope grows.
Replace it with one of:

- precomputed candidate queue
- hash/mod sampling
- random offset over a stable id list

## 8. Make mart refresh more delta-oriented

Current mart refresh logic is safe and explicit, but project refresh still does a lot of delete/rebuild work.

Improve in phases:

### Phase A

- keep the current queue and generation model
- reduce unnecessary full project rebuilds
- distinguish config changes from content-only changes

Examples:

- article-level judgment changes should stay article-level
- prompt/order/enable changes may require project-level work
- model/content-mode changes may require broader rebuilds

### Phase B

For project refreshes, prefer:

- staging changed article ids
- recomputing only affected rollups/serving rows when possible
- avoiding wholesale delete/reinsert of unaffected rows

### Phase C

For the heaviest marts, consider project-local shadow generations plus swap/finalize, instead of repeated purge-and-rebuild patterns.

## 7. Tune checkpoints and memory after the shape changes

After the write-shape work above lands, tune:

- `DUCKDB_APPEND_LANE_COUNT`
- `DUCKDB_MEMORY_LIMIT`
- `DUCKDB_TEMP_DIRECTORY`
- checkpoint cadence after heavy append/rebuild bursts

Do not tune these first. The query/write shape is the larger lever.

## Guardrails

- Do not parallelize canonical multi-table writes just to raise throughput.
- Keep one control write queue for canonical app-state mutations.
- Keep append lanes limited to append-only, deduped workloads.
- Keep background mart work separate from foreground canonical writes.
- Do not add automatic retries for non-idempotent user-facing writes.

## Suggested rollout order

1. Metrics first
2. Statement-list / prepared / appender helpers
3. Convert `appendJudgments` and other append-only paths onto the clearer fast path
4. Convert `ProjectsRoutes.ts` / `PromptsRoutes.ts` / `ComparisonProjectsRoutes.ts` to staging-table diffs
5. Reduce mart write amplification
6. Then tune checkpoint/lane settings

## Acceptance checks

- lower p95 control-queue wait for write-heavy routes
- fewer SQL statements per large project edit
- higher sustained rows/sec for judgment imports
- lower WAL growth per mart refresh batch
- no increase in duplicate-row or partial-write incidents
