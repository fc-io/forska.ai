# Better Mart PR Plan

## Scope

- No HTTP contract changes.
- Lease semantics stay unchanged.
- `app.judgment` import is the only append-lane write path.

## PR 1 - Baseline and counters

### Schema

- None.

### API

- None.

### Code

- Add import counters in `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`:
  - rows imported
  - batch duration
  - batch size bytes
- Add mart counters in `src/server/services/getDuckdbMartRefreshService.ts`:
  - queue depth
  - drain duration
  - projects refreshed per pass
- Add route timing in `src/server/routes/ProjectsRoutes.ts` for `/api/projects`.

### Verify

- Baseline numbers exist before runtime changes.

## PR 2 - Node-api spike

### Schema

- None.

### API

- None on prod path.

### Code

- Add `@duckdb/node-api` to `package.json`.
- Add isolated spike files:
  - `src/server/utils/duckdbServiceNodeApiSpike.ts`
  - `src/server/utils/duckdbServiceNodeApiSpike.test.ts`
- Prove:
  - cached instance open
  - 2-4 connections
  - query/run/transaction
  - checkpoint
  - clean close

### Verify

- `bun test src/server/utils/duckdbServiceNodeApiSpike.test.ts`

## PR 3 - Embedded control lane parity

### Schema

- None.

### API

- Keep `src/server/utils/duckdbService.ts` public surface unchanged:
  - `runDuckdbJsonQuery`
  - `runDuckdbStatement`
  - `runDuckdbTransaction`
  - `runDuckdbMaintenance`
  - `createDuckdbSnapshot`
  - `deleteDuckdbSnapshot`
  - `closeDuckdbService`
- No caller changes in `src/server/services/appDatabaseService.ts`.

### Code

- Replace child-process state with node-api state:
  - cached instance by DB path
  - 1 control connection
  - 1 serialized promise queue
- Apply current startup config on instance or control connection:
  - `memory_limit`
  - `temp_directory`
- Keep snapshot/checkpoint/shutdown behavior aligned with today.

### Files

- `src/server/utils/duckdbService.ts`
- small adjacent helpers only if needed

### Verify

- App boots with no app caller changes.
- Snapshot/checkpoint still work.

## PR 4 - Mart queue correctness + coalescing

### Schema

- Add DuckDB migration `src/db/duckdbMigrations/0023_martRefreshQueueGeneration.sql`:

```sql
ALTER TABLE app.mart_refresh_queue
ADD COLUMN refresh_generation BIGINT NOT NULL DEFAULT 0;
```

### API

- Internal only.
- Extend queued task row shape in `src/server/services/getDuckdbMartRefreshService.ts`:

```ts
type MartRefreshTaskRow = {
  id: string
  refreshScope: string
  projectId: string | null
  articleId: string | null
  refreshGeneration: number
}
```

### Code

- In `queueMartRefreshTasks()`:
  - keep same unique key `(refresh_scope, project_key, article_key)`
  - on conflict: `refresh_generation = app.mart_refresh_queue.refresh_generation + 1`
  - still update `reason`, `updated_at`
- In `getQueuedTasks()` select `refresh_generation`.
- Replace `deleteQueuedTasks(taskIds)` with conditional delete by `(id, refresh_generation)`.
- In `processQueuedMartRefreshes()`:
  - refresh `judgment_article` rows first
  - collect impacted project ids into one set
  - refresh each project once per pass
- Remove the duplicate `review_article_filter_posting` rebuild from project refresh SQL.

### Files

- `src/db/duckdbMigrations/0023_martRefreshQueueGeneration.sql`
- `src/server/services/getDuckdbMartRefreshService.ts`

### Verify

- Requeue during active drain survives.
- Repeated article hits rebuild each impacted project once/pass.

## PR 5 - Time-budgeted mart drain

### Schema

- None.

### API

- Keep `duckdbMartRefreshService.flush()` stable.
- Internal helper split is fine, for example:

```ts
processQueuedMartRefreshPass: () => Promise<boolean>
yieldToEventLoop: () => Promise<void>
```

### Code

- Replace one large drain with repeated passes under a time budget.
- Yield with timer/event-loop reschedule between passes.
- Yield at project boundary, not mid-project.
- Keep `martRefreshDrainPromise` single-flight.

### Files

- `src/server/services/getDuckdbMartRefreshService.ts`

### Verify

- `/api/projects` stays responsive while backlog drains.

## PR 6 - SQLite outbox claiming

### Schema

- Extend local SQLite `judgment_outbox` schema in `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`:
  - `export_claim_id TEXT`
  - `export_claimed_at TEXT`
  - `export_claimed_by TEXT`
- Add index:

```sql
CREATE INDEX IF NOT EXISTS idx_judgment_outbox_claim
  ON judgment_outbox(exported_at, export_claimed_at, outbox_seq);
```

- Add bootstrap `ALTER TABLE` for existing job DBs when columns are missing.

### API

- Replace `getPendingOutboxBatch()` usage with claim-based methods:

```ts
type OutboxClaim = {claimId: string; jobId: string; rowCount: number}

claimPendingOutboxBatch: (args: {claimedBy: string; jobId?: string; maxBytes: number; maxRows: number}) =>
  Promise<{claim: OutboxClaim; rows: JudgmentJobSqliteOutboxEntry[]} | null>

completeOutboxClaim: (args: {claimId: string; jobId: string}) => Promise<number>

releaseOutboxClaim: (args: {claimId: string; errorMessage: string | null; jobId: string}) => Promise<number>

reapStaleOutboxClaims: (args: {staleBefore: Date; jobId?: string}) => Promise<number>
```

### Code

- Claim rows in one SQLite transaction.
- Increment `export_attempts` on claim acquisition.
- `completeOutboxClaim()` sets `exported_at`, clears claim fields, clears `last_error`.
- `releaseOutboxClaim()` clears claim fields, writes `last_error`.
- Add stale-claim reap call in `src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts`.

### Files

- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts`
- adjacent tests

### Verify

- Two import workers cannot claim the same outbox rows.
- Stale claims return to pending.

## PR 7 - Append lane pool

### Schema

- None.

### API

- Add internal append API in `src/server/utils/duckdbService.ts`:

```ts
type JudgmentInsertRow = {
  id: string
  articleId: string
  modelId: string
  promptId: string
  projectId: string | null
  isAnswered: boolean
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  confidenceOriginal: number
  explanation: string | null
  quotes: unknown
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  chunkingStrategy: string | null
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  createdAt: Date
  updatedAt: Date
}

type AppendResult = {attempted: number; inserted: number; skipped: number}

appendDuckdbJudgments: (rows: JudgmentInsertRow[]) => Promise<AppendResult>
```

- Add passthrough in `src/server/services/appDatabaseService.ts`:

```ts
appendJudgments: (rows: JudgmentInsertRow[]) => Promise<AppendResult>
```

### Code

- Add 2 append-lane connections on the cached instance.
- Round-robin scheduler is enough for v1.
- Use prepared `INSERT ... ON CONFLICT DO NOTHING`.
- Run one transaction per claimed batch.
- Restrict append lanes to outbox import only.
- Prove startup config parity on all lanes.

### Files

- `src/server/utils/duckdbService.ts`
- `src/server/services/appDatabaseService.ts`

### Verify

- Append path exists.
- Reads and mart work still stay on control lane.

## PR 8 - Move importer to claims + append lanes

### Schema

- None.

### API

- Update importer entry points:

```ts
importJudgmentJobSqliteOutboxBatch: (args?: {claimedBy?: string; jobId?: string}) => Promise<number>

flushJudgmentJobSqliteOutbox: (args?: {claimedBy?: string; jobId?: string}) => Promise<number>
```

### Code

- In `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`:
  1. claim batch
  2. append on one lane
  3. if `inserted > 0`, queue unique article refreshes
  4. complete claim
  5. on failure, release claim
- In `src/server/cron/judgmentsJobs.ts`, pass `serverJobId` as `claimedBy`.
- In `src/server/routes/JudgmentsJobsRoutes.ts`, pass `serverJobId` when flushing before delete.

### Files

- `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`
- `src/server/cron/judgmentsJobs.ts`
- `src/server/routes/JudgmentsJobsRoutes.ts`

### Verify

- Import still works end to end.
- No duplicate rows.
- No partial-success claim leaks.

## PR 9 - Quiet barrier + hardening

### Schema

- None.

### API

- Internal barrier helper in `src/server/utils/duckdbService.ts`, for example:

```ts
withDuckdbQuietBarrier: <T>(label: string, work: () => Promise<T>) => Promise<T>
```

- Use barrier inside:
  - `runDuckdbMaintenance`
  - `createDuckdbSnapshot`
  - `closeDuckdbService`

### Code

- Stop new append dispatch while barrier is active.
- Wait active append lanes idle.
- Run checkpoint/snapshot/shutdown on control lane after drain.
- Add tests for:
  - lane isolation
  - barrier safety
  - claim recovery
  - importer idempotency
  - mart requeue during drain
  - mart coalescing

### Files

- `src/server/utils/duckdbService.ts`
- `src/server/services/getDuckdbMartRefreshService.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`
- new focused tests as needed

### Verify

- Steady-state load no longer causes long DB route stalls.
- Snapshot/checkpoint/shutdown are safe with append lanes active.

## PR 10 - Optional appender

### Schema

- None.

### API

- Keep `appendJudgments()` stable.
- Only swap implementation behind it.

### Code

- Benchmark appender vs prepared inserts.
- Switch only if duplicate-delivery risk is fully addressed.

### Verify

- Throughput gain is material.
- Semantics stay unchanged.

## Open decisions

- Keep current soft-delete behavior, or also bump `delete_generation` on delete so replay-after-delete works cleanly.
- Keep refresh-on-skipped-conflict parity, or only queue mart work when `inserted > 0`.
- Keep mart queue schema minimal with `refresh_generation` only, unless later evidence says claim columns are needed too.
