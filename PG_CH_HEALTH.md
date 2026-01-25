# Plan: PostgreSQL ↔ ClickHouse Sync Health

## Recent Fixes (Done)

- [x] Fix CH DateTime parsing (UTC; no `new Date(str)` / `+ 'Z'`)
- [x] Temp: filter `deletedAt IS NULL` in CH query layer (until delete-only table)
- [x] Normalize CH `quotes` to `string[]` (JSON string/array)
- [x] Fix CH inserts sending `null` to non-null cols (`articleTitle`)
- [x] Doc: CH delete syntax/params (no `?`; use `query_params`)

## Target Architecture

PostgreSQL is source of truth. Target: CH holds only live rows (no tombstones) via **MergeTree + deletes**.

| Operation | CH Action |
|-----------|-----------|
| PG insert | INSERT into CH |
| PG update | DELETE + INSERT in CH |
| PG judgment soft-delete (`deletedAt`) | DELETE FROM CH |
| PG article hard-delete | DELETE FROM CH |

Requires CH delete support + monotonic watermark not derived from table (deletes can drop `max(updatedAt)`). Deletes async → temp dupes/count mismatch.

Delete propagation (both paths):
- Write-path (API): when deleting in PG → issue CH delete by id (best-effort; retryable)
- Backfill: also apply deletes missed by write-path
  - Judgments: read `deletedAt` since watermark → CH delete
  - Articles: hard-deletes need a PG delete log (or periodic id diff) → CH delete

---

## Current State

Manual backfill routes:

| Route | Purpose |
|-------|---------|
| `POST /api/admin/backfill-judgments-to-clickhouse` | Sync new rows from `max(createdAt)` forward |
| `POST /api/admin/sync-deleted-judgments-to-clickhouse` | Sync soft-deletes (insert tombstones) |
| `POST /api/admin/sync-articles-to-clickhouse` | Sync articles by `updated_at` |
| `GET /api/admin/clickhouse-sync-status` | Health check comparing max createdAt |

Current CH impl uses tombstones (`deletedAt`) + ReplacingMergeTree-ish semantics. Target removes tombstones (physical deletes).

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

### Phase 1: Live-Only Table (No Tombstones)

- [ ] Decide table layout (tradeoffs):
  - Query perf: cluster by `articleId`/`promptId`/`modelId`
  - Delete perf: `DELETE WHERE id=...` needs `id` in `ORDER BY` prefix OR skip index on `id`
  - Types: prefer `UUID` cols + `LowCardinality(String)` dims (requires code/query casts)
  - Millions+ rows: avoid per-row mutations; batch; watch `system.mutations`

- [ ] Create new table (example; tune `ORDER BY`):

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

- [ ] Update `scripts/clickhouse-setup.sql`
- [ ] Remove S3Queue/MV (or make it write new schema; no `deletedAt`)
- [ ] Remove `deletedAt` column usage in code (filters + selects + types + writers)
- [ ] Add skip indexes/projection if needed (`id` deletes; `promptId/modelId` filters; `articleImportRoute` scoping)
- [ ] Drop old table, rename new table
- [ ] Full resync from PG (prefer CH-side `INSERT SELECT` or server batch insert; avoid 1-row inserts)
- [ ] Post-migration checks:
  - `count()` vs PG live count
  - `count() - uniqExact(id)` ≈ 0 (or accept while mutating)
  - `system.mutations` backlog near 0

### Phase 2: Unified Sync Endpoint

- [ ] Create `POST /api/admin/sync-judgments-to-clickhouse`:
  1. Get watermark from durable state (table/kv), not `max(updatedAt)` on `forska.judgments`
  2. Fetch PG rows where `(updatedAt, id) > watermark`
  3. For each row:
     - If `deletedAt IS NOT NULL`: `ALTER TABLE forska.judgments DELETE WHERE id = {id:String}`
     - Else: `ALTER TABLE ... DELETE WHERE id = {id:String}` then `INSERT`
- [ ] Use keyset pagination `(updatedAt, id)` — no OFFSET
- [ ] Tie-breaker ordering must match PG+CH (UUID vs String): use `id::text` in PG (or CH `UUID`)
- [ ] Batch deletes/inserts (avoid per-row mutations); monitor `system.mutations` backlog
- [ ] CH insert schema strict: never send `null` to non-null cols (e.g. `articleTitle String`)
- [ ] ClickHouse has no `?` placeholders; use `{id:String}` + `query_params` (or batched `IN (...)`)
- [ ] Deprecate old endpoints: `backfill-judgments`, `sync-deleted-judgments`

### Phase 3: Improve Health Check

- [ ] Compare counts:
  - PG: `COUNT(*) WHERE deletedAt IS NULL`
  - CH: `COUNT(*)`
  - Should match
- [ ] Compare `max(updatedAt)` with same predicate (PG `deletedAt IS NULL`, CH is live-only)
- [ ] If `system.mutations` has pending deletes, report `status=mutating` (avoid false alerts)
- [ ] Avoid parsing CH datetime strings in JS; prefer epoch:
  - CH: `toUnixTimestamp64Milli(max(updatedAt)) AS maxUpdatedAtMs`
- [ ] Return structured status:

```typescript
{
  postgres: { count: 150000, maxUpdatedAt: '...' },
  clickhouse: { count: 150000, maxUpdatedAt: '...' },
  inSync: true
}
```

### Phase 4: Fix Articles Sync

- [ ] Refactor `scripts/syncArticlesToClickHouse.ts` to use keyset pagination `(updated_at, id)`
- [ ] Remove `LIMIT/OFFSET`
- [ ] Handle article deletes:
  - Write-path (API): on PG delete → CH delete by id
  - Backfill: consume delete log (or periodic id diff) → CH delete

### Phase 5: Address Denorm Drift

- [ ] Decide strategy:
  - **Option A:** Accept drift (current, simplest)
  - **Option B:** Join to `forska.articles` at query time
  - **Option C:** Re-sync affected judgments when article updated

### Phase 6: Automated Sync (Optional)

- [ ] Cron job to run sync periodically
- [ ] Alert when count mismatch detected

---

## Testing Checklist

- [ ] New judgments sync correctly
- [ ] Updated judgments sync correctly (old row deleted, new inserted)
- [ ] Soft-deleted judgments removed from CH
- [ ] Deleted articles removed from CH
- [ ] Health check shows matching counts
- [ ] Keyset pagination handles cursor ties correctly
- [ ] Load test: sync 100k judgments

---

## Scale Notes (Millions+ Rows)

- Row-level deletes are expensive; keep deletes batched + monitor `system.mutations`
- Avoid full-table `COUNT(*)` in health checks (use time window / sampling / slower cron)
- Keep CH `articles` slim (don’t sync `full_text`/PDF blobs unless needed)
- Keep PG reads lean during sync (avoid `SELECT *` from `articles`)
- Prefer compact CH types: `UUID`, `LowCardinality(String)` for dims
- `ILIKE '%...%'` on `articleTitle` is scan-heavy; consider skip index (`tokenbf_v1`/`ngrambf_v1`) or limit search

## Key Files

| File | Purpose |
|------|---------|
| `src/server/routes/AdminInvestigateRoutes.ts` | Sync endpoints, backfill logic |
| `src/services/clickhouse/clickhouseClient.ts` | CH client singleton |
| `scripts/clickhouse-setup.sql` | DDL for judgments table |
| `scripts/syncArticlesToClickHouse.ts` | Articles sync |

---

## Rollback Plan

1. Revert code changes
2. Truncate CH judgments table
3. Run full backfill from PG
4. Verify counts match
