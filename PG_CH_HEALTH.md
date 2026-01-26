# Plan: PostgreSQL ↔ ClickHouse Sync Health

## Policy (Hard Deletes)

- PG `articles` + `judgments`: hard delete rows (no soft delete / no `deleted_at`)
- CH: live-only replica; deletes require write-path CH delete + delete log + periodic id diff/reconcile

## Checklist (Hard Delete + CH Delete)

- [ ] PG: remove `judgments.deleted_at` (schema + `bun run db:gen` + `bun run db:mig`)
- [ ] Write-path: on PG delete (articles/judgments) also best-effort CH delete by id
- [ ] PG delete log table: `entity` + `entityId` + `deletedAt` + `issuedAt` + `attempts` + `lastError`
- [ ] Write-path: insert delete-log row in same PG tx as delete
- [ ] Replay job: batch unissued delete-log rows → issue CH deletes → mark issued (retryable)
- [ ] Periodic reconcile: bucketed diff (count/hash) → id diff only on mismatch → targeted repair
- [ ] Health: surface delete-log backlog + oldest pending + CH `system.mutations` pending

## Recent Fixes (Done)

- [x] Fix CH DateTime parsing (UTC; no `new Date(str)` / `+ 'Z'`)
- [x] Temp: filter live-only rows in CH query layer
- [x] Normalize CH `quotes` to `string[]` (JSON string/array)
- [x] Fix CH inserts sending `null` to non-null cols (`articleTitle`)
- [x] Doc: CH delete syntax/params (no `?`; use `query_params`)

## Removed Legacy Code

Removed in favor of unified `sync-judgments-to-clickhouse` endpoint:

| Removed | Description |
|---------|-------------|
| `POST /api/admin/backfill-judgments-to-clickhouse` | Old endpoint; synced from `max(createdAt)` forward |
| `POST /api/admin/sync-deleted-judgments-to-clickhouse` | Old endpoint; synced soft-deletes separately |
| `GET /api/admin/backfill-progress` | Progress tracking for old backfill |
| `scripts/syncDeletedJudgmentsToClickhouse.ts` | CLI script for deleted judgments sync |
| `runBackfillAsync()` | Function for old backfill logic |
| `syncDeletedJudgmentsToClickhouse()` | Function for old delete sync |
| `BackfillProgress` type + state | Progress tracking state |

## Target Architecture

PostgreSQL is source of truth. Target: CH holds only live rows (no tombstones) via **MergeTree + deletes**.

| Operation | CH Action |
|-----------|-----------|
| PG insert | INSERT into CH |
| PG update | DELETE + INSERT in CH |
| PG judgment delete | DELETE FROM CH |
| PG article hard-delete | DELETE FROM CH |

Requires CH delete support + monotonic watermark not derived from table (deletes can drop `max(updatedAt)`). Deletes async → temp dupes/count mismatch.

Delete propagation (both paths):
- Write-path (API): on PG delete → issue CH delete by id (best-effort) + append to PG delete log (same transaction)
- Backfill: replay delete log (retry until issued; track mutation backlog)
- Reconcile: periodic PG↔CH id/hash diff by time buckets; if mismatch → targeted resync + replay deletes

---

## Current State

Sync routes:

| Route | Purpose |
|-------|---------|
| `POST /api/admin/sync-judgments-to-clickhouse` | Unified upsert sync (keyset pagination on `updatedAt,id`; deletes handled via delete log/diff) |
| `POST /api/admin/sync-articles-to-clickhouse` | Sync articles by `updated_at` |
| `GET /api/admin/clickhouse-sync-status` | Health check comparing counts/timestamps |

CH uses MergeTree + physical deletes (no tombstones).

---

## Known Limitations

### 1. No Real-Time Sync

CH lags PG until backfill run manually. No CDC.

### 2. Cursor Uses createdAt Only

Backfill uses `WHERE createdAt > max(createdAt)`. Updates/deletes missed. Cursor ties can skip rows.

### 3. Articles Sync Uses OFFSET

`syncArticlesToClickHouse` uses `LIMIT/OFFSET`. Slow at scale, skip/dup on concurrent writes.

### 4. Denorm Drift

Judgments store `articleTitle/*` snapshots. Article updates in PG won't update existing CH judgment rows.

### 5. Watermark Can Regress (If Using Deletes)

If CH physically deletes latest-updated row, `max(updatedAt)` in CH can go backwards → resync loops / duplicate work.

### 6. Deletes Are Async (Mutations)

DELETEs can lag; old+new rows can coexist until mutation done. Health checks must tolerate or check `system.mutations`.

---

## Implementation Checklist

### Phase 1: ClickHouse Live-Only Table (No Tombstones)

- [x] Decide CH table layout (`forska.judgments`) (tradeoffs):
  - Query perf: cluster by `articleId`/`promptId`/`modelId`
  - Delete perf: `DELETE WHERE id=...` needs `id` in `ORDER BY` prefix OR skip index on `id`
  - Types: prefer `UUID` cols + `LowCardinality(String)` dims (requires code/query casts)
  - Millions+ rows: avoid per-row mutations; batch; watch `system.mutations`

- [x] Create new table (example; tune `ORDER BY`):

```sql
CREATE TABLE forska.judgments_new (
    id String,
    createdAt DateTime64(6, 'UTC'),
    updatedAt DateTime64(6, 'UTC'),
    articleId String,
    articleTitle String,
    articleCreatedAt Nullable(DateTime64(6, 'UTC')),
    articleUpdatedAt Nullable(DateTime64(6, 'UTC')),
    articleCreatedYear Nullable(Int32),
    articleUpdatedYear Nullable(Int32),
    articleImportRoute Nullable(String),
    articleImportedBy Nullable(String),
    promptId String,
    modelId String,
    useTitle Bool DEFAULT true,
    useAbstract Bool DEFAULT true,
    useFulltext Bool DEFAULT false,
    useFulltextNoImages Bool DEFAULT false,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(Nullable(String)) DEFAULT [],
    explanation Nullable(String),
    quotes Array(String) DEFAULT []
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(createdAt)
ORDER BY (articleId, promptId, modelId, id);
```

- [x] Update `scripts/clickhouse-setup.sql`
- [x] Remove S3Queue/MV (or make it write new schema)
- [ ] Drop PG `judgments.deleted_at` + remove soft-delete usage (switch to hard deletes)
- [x] Add skip index on `id` (bloom) for deletes/verify
- [x] Drop old table, rename new table
- [ ] Full resync from PG (UI backfill works if table empty)
- [ ] Post-migration checks:
  - `count()` vs PG live count
  - `count() - uniqExact(id)` ≈ 0 (or accept while mutating)
  - `system.mutations` backlog near 0

### Phase 2: Unified Sync Endpoint

- [x] Create `POST /api/admin/sync-judgments-to-clickhouse`:
  1. Get watermark from durable state (table/kv), not `max(updatedAt)` on `forska.judgments`
  2. Fetch PG rows where `(updatedAt, id) > watermark`
  3. For each row: `ALTER TABLE ... DELETE WHERE id = {id:String}` then `INSERT`
  4. Deletes: not derivable from PG table scan after hard delete → use delete log (or periodic id diff)
- [x] Use keyset pagination `(updatedAt, id)` — no OFFSET
- [x] Tie-breaker ordering must match PG+CH (UUID vs String): use `id::text` in PG (or CH `UUID`)
- [x] Batch deletes/inserts (avoid per-row mutations); monitor `system.mutations` backlog
- [x] CH insert schema strict: never send `null` to non-null cols (e.g. `articleTitle String`)
- [x] ClickHouse has no `?` placeholders; use `{id:String}` + `query_params` (or batched `IN (...)`)
- [x] Removed old endpoints: `backfill-judgments`, `sync-deleted-judgments`

### Phase 3: Improve Health Check

- [x] Compare counts:
  - PG: `COUNT(*)`
  - CH: `COUNT(*)`
  - Should match
- [x] Compare `max(updatedAt)`
- [x] If `system.mutations` has pending deletes, report `status=mutating` (avoid false alerts)
- [x] Avoid parsing CH datetime strings in JS; prefer epoch:
  - CH: `toUnixTimestamp64Milli(max(updatedAt)) AS maxUpdatedAtMs`
- [x] Return structured status:

```typescript
{
  postgres: { count: 150000, maxUpdatedAt: '...' },
  clickhouse: { count: 150000, maxUpdatedAt: '...' },
  inSync: true
}
```

### Phase 4: Fix Articles Sync

- [x] Refactor `scripts/syncArticlesToClickHouse.ts` to use keyset pagination `(updated_at, id)`
- [x] Remove `LIMIT/OFFSET`
- [x] Handle article deletes:
  - Write-path (API): `DELETE /api/articles/:id` → CH delete by id (best-effort)
  - Backfill (manual UI trigger): `POST /api/admin/sync-deleted-articles-to-clickhouse` (also `bun scripts/syncDeletedArticlesToClickHouse.ts`)

### Phase 5: Address Denorm Drift

- [x] Decision: **Option A** — accept drift (no implementation needed)

### Phase 6: PeerDB CDC (Replaces Manual Sync)

Self-hosted PeerDB for real-time PG→CH replication. Removes need for manual sync endpoints + cron.

#### 6.1 Setup

- [ ] Deploy PeerDB (Docker Compose or k8s); requires PG logical replication enabled
- [ ] Configure PG publication for `articles` + `judgments` tables
- [ ] Create PeerDB mirror: PG → CH (`forska.judgments`, `forska.articles`)
- [ ] Tune PeerDB settings: batch size, parallelism, initial snapshot strategy

#### 6.2 Schema Alignment

- [ ] Ensure CH schema matches PeerDB expectations (column types, nullability)
- [ ] Handle `quotes` array: PeerDB may need custom transform (PG `text[]` → CH `Array(String)`)
- [ ] Handle denormalized cols (`articleTitle`, etc.): decide if PeerDB replicates raw or if we keep denorm logic

#### 6.3 Delete Handling

- [ ] PeerDB supports hard deletes via logical replication (DELETE events → CH DELETE)
- [ ] Remove PG delete log table (no longer needed)
- [ ] Remove delete replay job
- [ ] Remove periodic id-diff reconcile (PeerDB handles consistency)

#### 6.4 Remove Manual Sync Code

| To Remove | File |
|-----------|------|
| `POST /api/admin/sync-judgments-to-clickhouse` | `AdminInvestigateRoutes.ts` |
| `POST /api/admin/sync-articles-to-clickhouse` | `AdminInvestigateRoutes.ts` |
| `scripts/syncArticlesToClickHouse.ts` | scripts |
| Keyset pagination helpers | shared utils |
| Watermark state management | if stored externally |

#### 6.5 Health Check Updates

- [ ] Monitor PeerDB lag (`peerdb.lag_seconds` or similar metric)
- [ ] Monitor PeerDB slot replication lag in PG (`pg_replication_slots`)
- [ ] Keep count comparison (PG vs CH) as sanity check
- [ ] Alert on PeerDB mirror failure or slot inactive

#### 6.6 Rollback Plan

If PeerDB fails:
1. Re-enable manual sync endpoints
2. Truncate CH tables
3. Full resync via old backfill
4. Drop PeerDB publication + slot

#### 6.7 Tradeoffs

| Pro | Con |
|-----|-----|
| Real-time sync (no lag) | Extra infra (PeerDB service) |
| Automatic delete propagation | Logical replication slot consumes WAL |
| Less custom code | Schema changes need coordination |
| Built-in monitoring | Learning curve |

### Phase 7: Automated Alerts (Optional)

- [ ] Alert when PeerDB lag > threshold
- [ ] Alert when count mismatch detected (fallback sanity check)

---

## Testing Checklist

- [ ] New judgments sync correctly
- [ ] Updated judgments sync correctly (old row deleted, new inserted)
- [ ] Deleted judgments removed from CH
- [ ] Deleted articles removed from CH
- [ ] Health check shows matching counts
- [ ] Keyset pagination handles cursor ties correctly
- [ ] Load test: sync 100k judgments

---

## Scale Notes (Millions+ Rows)

- Row-level deletes are expensive; keep deletes batched + monitor `system.mutations`
- Avoid full-table `COUNT(*)` in health checks (use time window / sampling / slower cron)
- Prefer `articles_stats` agg; rebuild partitions after deletes
- Keep CH `articles` slim (don’t sync `full_text`/PDF blobs unless needed)
- Keep PG reads lean during sync (avoid `SELECT *` from `articles`)
- Prefer compact CH types: `UUID`, `LowCardinality(String)` for dims
- `ILIKE '%...%'` on `articleTitle` is scan-heavy; consider skip index (`tokenbf_v1`/`ngrambf_v1`) or limit search

## Key Files

| File | Purpose |
|------|---------|
| `src/server/routes/AdminInvestigateRoutes.ts` | Sync endpoints, backfill logic |
| `src/services/clickhouse/clickhouseClient.ts` | CH client singleton |
| `src/services/clickhouse/ensureClickhouseArticlesTable.ts` | CH DDL incl. `articles_stats` |
| `scripts/clickhouse-setup.sql` | DDL for judgments + articles + stats |
| `scripts/syncArticlesToClickHouse.ts` | Articles sync |

---

## Rollback Plan

1. Revert code changes
2. Truncate CH judgments table
3. Run full backfill from PG
4. Verify counts match
