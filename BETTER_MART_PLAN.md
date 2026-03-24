# Better Mart Plan

## Goal

- Fix slow DB-backed requests after project creation/judgment import.
- Keep cross-process writer lease exactly as-is in `src/server/utils/serverRuntimeRole.ts` and `src/server/utils/duckdbOwnerLease.ts`.
- Improve ingest throughput without making all DB work concurrent.

## Current bottlenecks

- All DuckDB work is serialized through the CLI child-process queue in `src/server/utils/duckdbService.ts`.
- Judgment outbox import inserts through that same lane in `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`.
- Mart refresh is the main latency source: `src/server/services/getDuckdbMartRefreshService.ts` rewrites large project mart slices after `judgment_article` refreshes.
- DB-backed routes like `/api/projects` and `/api/models` wait behind refresh work.

## Decision

- Replace runtime DuckDB access with `@duckdb/node-api`.
- Use 1 cached embedded instance.
- Keep 1 serialized control lane for:
  - `queryJson`
  - `run`
  - `transaction`
  - `createSnapshot`
  - `maintenance`
  - `shutdown`
- Add append lanes only for high-throughput `app.judgment` inserts from the SQLite outbox import path.
- Start with 2 append lanes. Expand to 4 only if benchmarks justify it.

## Important caveat

- Append lanes help ingest throughput.
- Append lanes do not solve mart slowness by themselves.
- If ingest gets faster while mart refresh stays unchanged, backlog can grow faster.

## Why this shape

- DuckDB supports concurrent appends within one process.
- We already have the right single-writer process boundary via the lease.
- The current import path builds large SQL strings and runs one batch at a time.
- Embedded mode removes CLI-process fragility, lock churn, stdout parsing, and child-process lifecycle issues.

## Non-goals

- Do not make all DB work concurrent.
- Do not change lease ownership semantics.
- Do not move reads to append lanes.
- Do not change non-import judgment writes until import is stable.

## Progress

- [ ] PR 1 - Baseline and counters
- [ ] PR 2 - Node-api spike
- [ ] PR 3 - Embedded control lane parity
- [ ] PR 4 - Remove old CLI runtime path
- [ ] PR 5 - SQLite outbox claiming
- [ ] PR 6 - Append lane pool
- [ ] PR 7 - Move importer to claims plus append lanes
- [ ] PR 8 - Mart queue coalescing
- [ ] PR 9 - Time-budgeted mart drain
- [ ] PR 10 - Cleanup and hardening
- [ ] PR 11 - Optional appender follow-up

## Recommended rollout

### Phase 0 - Baseline

- [ ] Measure outbox rows/sec imported
- [ ] Measure median/p95 `GET /api/projects`
- [ ] Measure mart queue depth
- [ ] Measure time spent in mart refresh drain
- [ ] Save these as acceptance numbers

### Phase 1 - Spike `@duckdb/node-api` under Bun

- [ ] Verify Bun loads `@duckdb/node-api` reliably in local dev and test
- [ ] Prove cached instance opens
- [ ] Prove multiple connections open
- [ ] Prove transaction works
- [ ] Prove checkpoint works
- [ ] Prove snapshot equivalent works
- [ ] Prove clean shutdown on writer demotion
- [ ] Reach parity for current control-lane API

### Phase 2 - Swap `duckdbService` to embedded mode

- [ ] Rewrite `src/server/utils/duckdbService.ts` behind the existing public API
- [ ] Keep `src/server/services/appDatabaseService.ts` unchanged if possible
- [ ] Add instance cache keyed by DB path
- [ ] Keep 1 control connection
- [ ] Keep serialized control queue
- [ ] Apply startup config once
- [ ] Preserve checkpoint/snapshot/shutdown behavior
- [ ] Keep writer demotion cleanup hook

### Phase 3 - Add append-lane infrastructure

- [ ] Add lane manager inside `duckdbService.ts` or a sibling service
- [ ] Keep 1 control lane connection
- [ ] Add N append-lane connections
- [ ] Add round-robin or least-busy dispatch
- New API:

```ts
appendJudgments: (rows: JudgmentInsertRow[]) => Promise<AppendResult>
```

- [ ] Restrict append lanes to `app.judgment` import only
- [ ] Keep everything else on control lane

### Phase 4 - Add SQLite outbox claiming

- [ ] Add explicit claim state in `judgment_outbox`
- [ ] Add `export_claim_id`
- [ ] Add `export_claimed_at`
- [ ] Add `export_claimed_by`
- [ ] Claim batch in SQLite transaction
- [ ] Export claimed rows on one append lane
- [ ] Mark exported on success
- [ ] Release or retry claim on failure or stale claim
- [ ] Require this before multi-lane import

### Phase 5 - Move import path to append lanes

- [ ] Update `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`
- [ ] Replace giant `INSERT ... VALUES ... ON CONFLICT DO NOTHING` strings with lane-based inserts
- [ ] First use prepared `INSERT ... ON CONFLICT DO NOTHING` on each append lane
- [ ] Keep parity with current semantics

### Phase 6 - Optional appender optimization

- [ ] Only start after claims and exactly-once behavior are stable
- [ ] Evaluate DuckDB appender for `app.judgment`
- [ ] Verify duplicate delivery is impossible or pre-deduped before switching

### Phase 7 - Fix mart refresh bottleneck

- [ ] Coalesce many `judgment_article` updates into one impacted-project refresh set
- [ ] Refresh each impacted project once per drain cycle
- [ ] Remove duplicate `review_article_filter_posting` rebuild
- [ ] Replace tiny batch slicing with a time-budgeted drain loop
- [ ] Prefer project-level dedupe over repeated full rebuilds

## Concrete file plan

- `src/server/utils/duckdbService.ts`
  - replace CLI child-process runtime with embedded node-api runtime
  - add control queue + append lane pool
- `src/server/services/appDatabaseService.ts`
  - keep current methods
  - add `appendJudgments` passthrough
- `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
  - add outbox claim/release/stale-claim recovery
- `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`
  - claim rows
  - dispatch to append lane
  - mark exported / failed
- `src/server/services/getDuckdbMartRefreshService.ts`
  - coalesce and reduce repeated project refresh work

## Recommended API shape

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
```

## Lane rules

- Control lane owns:
  - reads
  - transactions
  - DDL
  - checkpoints
  - snapshots
  - mart refresh
  - maintenance
- Append lanes own:
  - append-only `app.judgment` import batches only
- If a path needs transaction semantics across tables, it stays on control lane.

## Recommendation on lane count

- Start: `1 control + 2 append lanes`
- Expand to `1 control + 4 append lanes` only if:
  - ingest is still the bottleneck
  - mart refresh has been coalesced enough to absorb higher ingest
  - no conflict/retry storm appears

## Risks

- Faster ingest can worsen mart backlog if mart path is unchanged.
- Appender may break current idempotency semantics.
- Bun + node-api compatibility needs an early spike, not a big-bang swap.
- Snapshot/checkpoint behavior must match current operational scripts.

## Acceptance criteria

- [ ] No child-process DuckDB runtime in dev/prod path
- [ ] `GET /api/projects` stays responsive while outbox import runs
- [ ] Outbox import throughput materially improves
- [ ] No duplicate `app.judgment` rows
- [ ] Writer demotion or shutdown remains safe
- [ ] Mart queue depth trends down under steady-state load

## PR-sized execution checklist

### PR 1 - Baseline and counters

- [ ] Add outbox imported rows or batch counter
- [ ] Add outbox import duration counter
- [ ] Add mart queue depth counter
- [ ] Add mart drain duration counter
- [ ] Add `/api/projects` duration counter
- Files:
  - `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`
  - `src/server/services/getDuckdbMartRefreshService.ts`
  - `src/server/routes/ProjectsRoutes.ts`
- Done when:
  - [ ] local numbers exist before any runtime rewrite

### PR 2 - Node-api spike

- [ ] Add small isolated runtime spike without wiring production path
- [ ] Prove cached instance opens
- [ ] Prove 2-4 connections open
- [ ] Prove run, query, transaction, checkpoint work
- [ ] Prove shutdown is clean
- Files:
  - `package.json`
  - `src/server/utils/duckdbServiceNodeApiSpike.ts`
  - `src/server/utils/duckdbServiceNodeApiSpike.test.ts`
- Done when:
  - [ ] Bun test passes for the spike

### PR 3 - Embedded control lane parity

- [ ] Swap `src/server/utils/duckdbService.ts` from CLI child process to embedded `@duckdb/node-api`
- [ ] Keep public API stable
- [ ] Keep 1 serialized control lane only
- Files:
  - `src/server/utils/duckdbService.ts`
  - small adjacent helpers only if needed
- Done when:
  - [ ] `queryJson`, `run`, `transaction`, `createSnapshot`, maintenance, shutdown still work
  - [ ] app runs without caller changes

### PR 4 - Remove old CLI runtime path

- [ ] Delete dead child-process code
- [ ] Keep lease behavior untouched
- Files:
  - `src/server/utils/duckdbService.ts`
  - any now-unused helper under `src/server/utils/`
- Done when:
  - [ ] no runtime DuckDB CLI child process remains in normal server path

### PR 5 - SQLite outbox claiming

- [ ] Add explicit claim lifecycle in `judgment_outbox`
- [ ] Add claim batch method
- [ ] Add load claimed rows method
- [ ] Add complete claim method
- [ ] Add fail or release claim method
- [ ] Add stale-claim reap method
- Files:
  - `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`
  - any adjacent tests
- Done when:
  - [ ] two import workers cannot process the same outbox rows concurrently

### PR 6 - Append lane pool

- [ ] Add 2 append-lane connections on the embedded instance
- [ ] Add lane scheduler; round-robin is enough for v1
- [ ] Add `appendJudgments(rows)` service API
- [ ] Keep first version on prepared inserts with `ON CONFLICT DO NOTHING`, not appender
- Files:
  - `src/server/utils/duckdbService.ts`
  - `src/server/services/appDatabaseService.ts`
- Done when:
  - [ ] append path exists and is isolated to `app.judgment`

### PR 7 - Move importer to claims plus append lanes

- [ ] Claim rows
- [ ] Load claimed rows
- [ ] Append on one lane
- [ ] Complete or release claim
- Files:
  - `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`
  - `src/server/cron/judgmentsJobs.ts`
- Done when:
  - [ ] import still works end-to-end with 2 append lanes
  - [ ] no duplicate `app.judgment` rows appear

### PR 8 - Mart queue coalescing

- [ ] Coalesce `judgment_article` work by impacted project before rebuilding
- [ ] Refresh each impacted project once per drain pass
- Files:
  - `src/server/services/getDuckdbMartRefreshService.ts`
- Done when:
  - [ ] repeated article-level queue entries do not trigger repeated full project rebuilds

### PR 9 - Time-budgeted mart drain

- [ ] Replace tiny fixed-slice draining with a time-budgeted loop
- [ ] Make the drain do meaningful work, then yield so reads stay responsive
- Files:
  - `src/server/services/getDuckdbMartRefreshService.ts`
- Done when:
  - [ ] `/api/projects` remains responsive while backlog drains

### PR 10 - Cleanup and hardening

- [ ] Remove duplicate rebuild work
- [ ] Tighten logs or metrics
- [ ] Add regression test for lane isolation
- [ ] Add regression test for claim recovery
- [ ] Add regression test for importer idempotency
- [ ] Add regression test for mart coalescing
- Files:
  - `src/server/services/getDuckdbMartRefreshService.ts`
  - `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`
  - new focused tests as needed
- Done when:
  - [ ] steady-state load no longer causes long DB route stalls

### PR 11 - Optional appender follow-up

- [ ] Only do this if prepared inserts are still the bottleneck
- [ ] Benchmark appender vs prepared inserts
- [ ] Switch only if duplicate-delivery risk is eliminated
- Files:
  - `src/server/utils/duckdbService.ts`
  - importer tests
- Done when:
  - [ ] throughput gain is material and semantics stay correct

## Suggested verify commands

- `bun test`
- `bun run build`
- `bun run dev:server`
- `bun run db:query:snapshot -- --sql "SELECT COUNT(*) FROM app.mart_refresh_queue"`
- `bun run db:query:snapshot -- --sql "SELECT COUNT(*) FROM app.judgment"`

## Recommendation

- Approve embedded DuckDB + control lane + append lanes.
- But do it with this priority:
  1. spike node-api
  2. embedded control lane parity
  3. SQLite outbox claiming
  4. 2 append lanes for judgment import
  5. mart refresh coalescing
  6. only then consider 4 lanes and/or appender
