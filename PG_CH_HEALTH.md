# Plan: PostgreSQL ↔ ClickHouse Sync Health

## Current State

PostgreSQL is the source of truth. ClickHouse is the analytics layer, synced via manual backfill routes:

| Route                                                  | Purpose                                     |
| ------------------------------------------------------ | ------------------------------------------- |
| `POST /api/admin/backfill-judgments-to-clickhouse`     | Sync new rows from `max(createdAt)` forward |
| `POST /api/admin/sync-deleted-judgments-to-clickhouse` | Sync soft-deleted rows (tombstones)         |
| `POST /api/admin/sync-articles-to-clickhouse`          | Sync articles by `updated_at`               |
| `GET /api/admin/clickhouse-sync-status`                | Health check comparing max createdAt        |

---

## Known Limitations

### 1. No Real-Time Sync

ClickHouse data lags behind PostgreSQL until backfill is run manually. There is no CDC (Change Data Capture) or event-driven sync.

### 2. Gaps Not Auto-Filled

Backfill uses `WHERE createdAt > max(createdAt)` cursor. If rows were inserted with earlier timestamps (unlikely but possible), they won't be picked up. **Fix:** Truncate CH table + full resync.

### 2b. Cursor Tie Bug (createdAt Not Unique)

Backfill pages only by `createdAt`. If >`batchSize` rows share same `createdAt`, tail rows are skipped forever (`>` cursor). **Fix:** keyset paginate on `(createdAt, id)` (or `(updatedAt, id)` post-Phase-1).

### 3. Updates Not Synced

`judgeStoreJudgment.ts` can update existing judgments (same id, new data). The backfill only looks at `createdAt`, so updates are missed. **Fix:** Full resync, or implement upsert logic.

### 4. Deletes Require Separate Sync

Soft deletes (setting `deletedAt`) are not automatically synced. Must run `sync-deleted-judgments-to-clickhouse` separately.

### 5. Tombstone Bug (ReplacingMergeTree Version Ties)

When a judgment is soft-deleted, `deletedAt` is set but `createdAt` remains unchanged. ReplacingMergeTree uses `createdAt` as version column. If the same record exists twice with identical `createdAt`, the winner is non-deterministic. **Impact:** Tombstones may not reliably replace live records.

### 6. Dedup is Eventual

ReplacingMergeTree deduplicates during background merges, not on insert. Queries may return duplicates until merge completes. Use `FINAL` modifier for guaranteed dedup (slower).

**Why this happens:** ClickHouse optimizes for write speed. When you insert a row with an existing `id`, both rows coexist in separate "parts" (immutable data chunks). Background merge processes eventually combine parts and keep only the row with the highest version (`updatedAt`). Until merge runs, `SELECT` without `FINAL` returns both rows.

**Impact:**

- Counts can be inflated (`COUNT(*)` counts duplicates)
- Aggregations may double-count affected rows
- `GROUP BY id` returns multiple rows per id

**Mitigations:**

1. Use `SELECT ... FINAL` for accuracy (forces dedup at query time, slower)
2. Use `OPTIMIZE TABLE forska.judgments FINAL` to force immediate merge (blocking, expensive)
3. Accept eventual consistency for dashboards; use `FINAL` only for exports/reports
4. Monitor dedup drift: `SELECT count() - uniqExact(id) FROM forska.judgments` should trend to 0

### 7. Health Check Can False-Alert

If PG max row is deleted (or CH filter differs), `max(createdAt)` comparison reports lag even when non-deleted data is in sync. **Fix:** compare consistent predicates (+ add `updatedAt`).

### 8. Deleted Sync Replays O(N)

`sync-deleted` can resend all deleted rows each run, growing merge load. **Fix:** cursor on `(deletedAt, id)` or `(updatedAt, id)` and only insert new tombstones.

### 9. Articles Sync Uses OFFSET

`syncArticlesToClickHouse` batches via `LIMIT/OFFSET`. Large backfills get slower as offset grows; concurrent writes can skip/dup. **Fix:** keyset paginate on `(updated_at, id)`.

### 10. Denorm Drift (Article Fields in Judgments)

Judgments store `articleTitle/*` snapshots. Later article updates in PG won’t update existing CH judgment rows. **Fix:** accept drift, or join to `forska.articles`, or resync judgments.

---

## Implementation Checklist

### Phase 1: Fix Tombstone Bug (Critical)

- [ ] Change ReplacingMergeTree version column from `createdAt` to `updatedAt`
  - `updatedAt` is set on soft-delete, guaranteeing tombstone wins
  - Requires table recreation + data migration (engine params not ALTERable)
- [ ] Update `scripts/clickhouse-setup.sql` with new schema:

  ```sql
  ENGINE = ReplacingMergeTree(updatedAt)  -- was createdAt
  ```

- [ ] Add `updatedAt` column to CH schema if missing:

  ```sql
  ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS updatedAt DateTime64(6, 'UTC');
  ```

- [ ] Update backfill logic to populate `updatedAt`:
  - `src/server/routes/AdminInvestigateRoutes.ts` - `runBackfillAsync()`
  - `src/server/routes/AdminInvestigateRoutes.ts` - `syncDeletedJudgmentsToClickhouse()`
  - `src/server/routes/AdminInvestigateRoutes.ts` - inline tombstone writes
- [ ] Fix cursor paging: move from `createdAt` cursor to `(updatedAt, id)` keyset paging (covers inserts+updates+deletes)
- [ ] Ensure CH inserts never send `null` to non-null columns (e.g. `articleTitle` is `String`)

- [ ] Truncate + full resync after schema change

### Phase 2: Unified Sync Endpoint

- [ ] Create single endpoint `POST /api/admin/sync-judgments-to-clickhouse` that:
  1. Uses CH watermark `(max(updatedAt), max(id) at that updatedAt)` for keyset paging
  2. Syncs all judgments where `(updatedAt, id)` is newer (covers inserts+updates+deletes)
- [ ] Deprecate separate `sync-deleted-judgments-to-clickhouse` endpoint

### Phase 3: Improve Sync Detection

- [ ] Add count comparison to health check:

  ```typescript
  {
    postgres: { count: 150000, maxCreatedAt: '...' },
    clickhouse: { count: 149800, maxCreatedAt: '...' },
    missingCount: 200,
    status: 'behind'
  }
  ```

- [ ] Add `updatedAt` lag detection:
  - Compare `max(updatedAt)` between PG and CH
  - Detect if updates are being missed

- [ ] Add tombstone count comparison:
  - PG: `COUNT(*) WHERE deletedAt IS NOT NULL`
  - CH: `COUNT(*) WHERE deletedAt IS NOT NULL`
- [ ] Add dedup drift signal:
  - CH: `count() - uniqExact(id)` (or sampled/partitioned) should trend to ~0 after merges

### Phase 4: Gap Detection & Repair

- [ ] Add endpoint `GET /api/admin/detect-sync-gaps`:
  - Compare judgment IDs between PG and CH for a date range
  - Return list of missing IDs

- [ ] Add endpoint `POST /api/admin/repair-sync-gaps`:
  - Accept list of judgment IDs
  - Fetch from PG and insert to CH
  - Handles both missing rows and stale rows

### Phase 5: Fix Articles Sync OFFSET

- [ ] Refactor `scripts/syncArticlesToClickHouse.ts` to use keyset pagination on `(updated_at, id)`
- [ ] Remove `LIMIT/OFFSET` pattern which degrades at scale and risks skip/dup on concurrent writes

### Phase 6: Address Denorm Drift

- [ ] Decide on strategy for article field drift in judgments:
  - **Option A:** Accept drift (simplest, current behavior)
  - **Option B:** Remove denormalized fields from CH judgments, join to `forska.articles` at query time
  - **Option C:** Re-sync affected judgments when article is updated (complex, high write amplification)
- [ ] Document chosen approach and update queries if needed

### Phase 7: Ensure FINAL Usage for Accurate Queries

- [ ] Audit all CH queries in codebase — add `FINAL` where accuracy matters (counts, exports, reports)
- [ ] For dashboards where eventual consistency is acceptable, document that counts may briefly inflate after sync

### Phase 8: Automated Sync (Optional)

- [ ] Cron job or scheduled task to run sync periodically
- [ ] Alert/notification when lag exceeds threshold
- [ ] Consider CDC via PostgreSQL logical replication (complex, may not be worth it)

---

## Testing Checklist

- [ ] Verify new judgments sync correctly
- [ ] Verify updated judgments sync correctly (after Phase 1)
- [ ] Verify soft-deleted judgments appear as tombstones in CH
- [ ] Verify `FINAL` queries exclude tombstoned records
- [ ] Verify health check reports accurate status
- [ ] Verify cursor tie case: >`batchSize` judgments with identical `createdAt`/`updatedAt` still sync
- [ ] Load test: sync 100k judgments, measure time

---

## Schema Reference

### Current ClickHouse Schema

```sql
CREATE TABLE forska.judgments (
    id String,
    createdAt DateTime64(6, 'UTC'),
    deletedAt Nullable(DateTime64(6, 'UTC')),
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
    answeredOriginalAsArray Array(Nullable(String)),
    explanation Nullable(String),
    quotes Nullable(String)
) ENGINE = ReplacingMergeTree(createdAt)
PARTITION BY toYYYYMM(createdAt)
ORDER BY (id);
```

### Proposed Schema Change

```sql
-- Add updatedAt column
ALTER TABLE forska.judgments
ADD COLUMN IF NOT EXISTS updatedAt DateTime64(6, 'UTC');

-- Recreate with updatedAt as version (engine param)
-- Create new table, backfill, swap names
```

---

## Key Files

| File                                          | Purpose                                 |
| --------------------------------------------- | --------------------------------------- |
| `src/server/routes/AdminInvestigateRoutes.ts` | Sync endpoints, backfill logic          |
| `src/services/clickhouse/clickhouseClient.ts` | CH client singleton                     |
| `scripts/clickhouse-setup.sql`                | DDL for judgments table                 |
| `scripts/syncArticlesToClickHouse.ts`         | Articles sync (separate from judgments) |

---

## Rollback Plan

If sync changes cause issues:

1. Revert code changes
2. Truncate CH judgments table
3. Run full backfill from PG
4. Verify counts match
