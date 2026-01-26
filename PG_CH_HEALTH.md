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

PostgreSQL is source of truth.

### Future Target: PeerDB + ReplacingMergeTree (Phase 6)

Real-time CDC via PeerDB. Uses **ReplacingMergeTree + soft deletes** pattern:

| Operation | CH Action |
|-----------|-----------|
| PG insert | INSERT row |
| PG update | INSERT row with higher `_peerdb_version` |
| PG delete | INSERT row with `_peerdb_is_deleted=1` |

Queries use `FINAL` or `argMax` for dedup + filter `_peerdb_is_deleted=0`.

### Current: Manual Sync + MergeTree (Phases 1-5)

Manual sync endpoints + MergeTree with physical deletes:

| Operation | CH Action |
|-----------|-----------|
| PG insert | INSERT into CH |
| PG update | DELETE + INSERT in CH |
| PG delete | DELETE FROM CH |

Requires CH delete support + monotonic watermark not derived from table (deletes can drop `max(updatedAt)`). Deletes async → temp dupes/count mismatch.

Delete propagation (current approach):
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

CH currently uses MergeTree + physical deletes. Target: ReplacingMergeTree + soft deletes (Phase 6).

---

## Known Limitations (Current Manual Sync)

*Most resolved by Phase 6 (PeerDB)*

### 1. No Real-Time Sync ✅ *Fixed by Phase 6*

CH lags PG until backfill run manually. No CDC. → PeerDB provides real-time CDC.

### 2. Cursor Uses createdAt Only ✅ *Fixed by Phase 6*

Backfill uses `WHERE createdAt > max(createdAt)`. Updates/deletes missed. Cursor ties can skip rows. → PeerDB uses WAL position, not table cursors.

### 3. Articles Sync Uses OFFSET ✅ *Fixed by Phase 6*

`syncArticlesToClickHouse` uses `LIMIT/OFFSET`. Slow at scale, skip/dup on concurrent writes. → PeerDB doesn't use OFFSET.

### 4. Denorm Drift ⚠️ *Remains*

Judgments store `articleTitle/*` snapshots. Article updates in PG won't update existing CH judgment rows. → Still applies with PeerDB (denorm is app-level).

### 5. Watermark Can Regress (If Using Deletes) ✅ *Fixed by Phase 6*

If CH physically deletes latest-updated row, `max(updatedAt)` in CH can go backwards → resync loops / duplicate work. → PeerDB uses WAL position (not table watermark) + soft deletes (no physical DELETE).

### 6. Deletes Are Async (Mutations) ✅ *Fixed by Phase 6*

DELETEs can lag; old+new rows can coexist until mutation done. Health checks must tolerate or check `system.mutations`. → PeerDB uses soft deletes; ReplacingMergeTree dedupes on merge but `FINAL` gives correct reads immediately.

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

Self-hosted PeerDB for real-time PG→CH replication. Uses **ReplacingMergeTree + soft deletes** pattern (not physical DELETEs).

**How PeerDB works:**
- INSERT → new row in CH
- UPDATE → new row with higher `_peerdb_version`
- DELETE → new row with `_peerdb_is_deleted=1`
- ReplacingMergeTree dedupes by version on merge; use `FINAL` or `argMax` for exact reads

#### 6.1 Postgres Setup

- [ ] Enable logical replication: `wal_level=logical`
- [ ] Create replication slot + publication for `articles` + `judgments`
- [ ] Create replication user with appropriate permissions
- [ ] Configure `pg_hba.conf` for replication connections
- [ ] **REPLICA IDENTITY**: Our CH ORDER BY is `(articleId, promptId, modelId, id)` — need unique index on these cols + `ALTER TABLE ... REPLICA IDENTITY USING INDEX ...` so deletes emit all key cols

#### 6.2 PeerDB Infrastructure

- [ ] Deploy PeerDB stack (Docker Compose or k8s)
- [ ] Stack includes MinIO for staging (bulk load pattern: PG → MinIO → CH)
- [ ] Ensure CH can reach MinIO endpoint (network config)
- [ ] Configure PeerDB mirror: PG → CH (`forska.judgments`, `forska.articles`)
- [ ] Tune: batch size, parallelism, initial snapshot strategy

#### 6.3 CH Schema Changes

Current MergeTree → **ReplacingMergeTree** with PeerDB cols:

```sql
CREATE TABLE forska.judgments (
    -- existing cols...
    id String,
    createdAt DateTime64(6, 'UTC'),
    updatedAt DateTime64(6, 'UTC'),
    -- ... other cols ...

    -- PeerDB cols (required)
    _peerdb_version Int64,
    _peerdb_is_deleted Int8 DEFAULT 0
) ENGINE = ReplacingMergeTree(_peerdb_version)
PARTITION BY toYYYYMM(createdAt)
ORDER BY (articleId, promptId, modelId, id);
```

- [ ] Add `_peerdb_version Int64` col
- [ ] Add `_peerdb_is_deleted Int8 DEFAULT 0` col
- [ ] Change ENGINE: MergeTree → ReplacingMergeTree(`_peerdb_version`)
- [ ] Handle `quotes` array: PeerDB may need transform (PG `text[]` → CH `Array(String)`)
- [ ] Decide denormalized cols (`articleTitle`, etc.): replicate raw from PG or keep denorm logic

#### 6.4 Query Layer Changes

All CH queries must handle dedup + filter deleted:

```sql
-- Option A: FINAL (simple, slower)
SELECT * FROM forska.judgments FINAL
WHERE _peerdb_is_deleted = 0;

-- Option B: argMax (faster, more complex)
SELECT argMax(col1, _peerdb_version) AS col1, ...
FROM forska.judgments
WHERE _peerdb_is_deleted = 0
GROUP BY id;
```

- [ ] Audit all CH queries in codebase
- [ ] Add `WHERE _peerdb_is_deleted = 0` filter to all queries
- [ ] Add `FINAL` or implement `argMax` pattern for dedup
- [ ] Consider materialized view for "current state" if FINAL too slow
- [ ] Update health check queries

#### 6.5 Remove Manual Sync Code

| To Remove | File |
|-----------|------|
| `POST /api/admin/sync-judgments-to-clickhouse` | `AdminInvestigateRoutes.ts` |
| `POST /api/admin/sync-articles-to-clickhouse` | `AdminInvestigateRoutes.ts` |
| `scripts/syncArticlesToClickHouse.ts` | scripts |
| Keyset pagination helpers | shared utils |
| Watermark state management | if stored externally |
| PG delete log table | schema (if implemented) |
| Delete replay job | (if implemented) |

#### 6.6 Health Check Updates

- [ ] Monitor PeerDB lag (replication delay)
- [ ] Monitor PG replication slot lag (`pg_replication_slots.pg_wal_lsn_diff`)
- [ ] Count comparison: PG `COUNT(*)` vs CH `COUNT(*) ... FINAL WHERE _peerdb_is_deleted=0`
- [ ] Alert on PeerDB mirror failure or slot inactive
- [ ] Alert on slot lag > threshold (WAL accumulating)

#### 6.7 Rollback Plan

If PeerDB fails:
1. Stop PeerDB mirror
2. Re-enable manual sync endpoints (revert code)
3. Recreate CH tables with MergeTree (drop ReplacingMergeTree + PeerDB cols)
4. Full resync via old backfill
5. Drop PG publication + replication slot

#### 6.8 Tradeoffs

| Pro | Con |
|-----|-----|
| Real-time sync (sub-second lag) | Extra infra (PeerDB + MinIO) |
| Correctness guarantees (snapshot + CDC handoff) | Query complexity (`FINAL` or `argMax` everywhere) |
| Bulk loading (staging → fast inserts) | Soft deletes (rows exist until merge) |
| Handles replays cleanly (idempotent) | REPLICA IDENTITY setup for non-PK ORDER BY |
| Production-ready monitoring | Schema changes to existing CH tables |
| No custom sync code to maintain | Learning curve |

### Phase 7: Automated Alerts (Optional)

- [ ] Alert when PeerDB lag > threshold
- [ ] Alert when PG slot lag > threshold (WAL growth)
- [ ] Alert when count mismatch detected (sanity check)

---

## Testing Checklist

- [ ] New judgments appear in CH (check `_peerdb_is_deleted=0`)
- [ ] Updated judgments: new version row exists, `FINAL` returns latest
- [ ] Deleted judgments: `_peerdb_is_deleted=1` row exists, filtered out in queries
- [ ] Same for articles
- [ ] Health check counts match (PG vs CH with FINAL + filter)
- [ ] REPLICA IDENTITY works: delete by non-PK cols propagates correctly
- [ ] Load test: sync 100k+ rows, verify no missing/duplicate after snapshot+CDC handoff
- [ ] Query perf acceptable with FINAL (or argMax pattern works)

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
