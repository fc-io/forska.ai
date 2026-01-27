# Plan: PG → CH (PeerDB) Health

## Policy

- PeerDB is sole writer to CH (no manual sync routes/scripts, no app-side CH deletes)
- PG keeps `judgments.deleted_at` for now; drop later after stable PeerDB
- CH schema:
  - `forska.articles` = PeerDB sink (PG `articles`)
  - `forska.judgments_raw` = PeerDB sink (PG `judgments`)
  - `forska.judgments` = live-only view (filters `deleted_at`, joins `articles`)

## Setup

Completed now:
- PeerDB stack running via `docker compose --profile peerdb up -d`
- [x] PG logical repl role/publication via `scripts/setupPeerdbPostgres.ts` (ran 2026-01-27)
- PeerDB peers + mirror via `scripts/setupPeerdbPgToClickhouse.ts`
- CH sink tables were renamed/dropped to unblock PeerDB validation

## Recent Fixes (Done)

- [x] PeerDB PG setup: avoid `$1` in `CREATE/ALTER ROLE ... PASSWORD`
- [x] PeerDB PG→CH setup: replace `DROP ... IF EXISTS` with catalog checks
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

## Health Signals

- PeerDB mirror status + lag
- PG slot active + WAL retention (`pg_replication_slots`)
- CH mutation backlog/stuck (if PeerDB uses UPDATE/DELETE → `system.mutations`)
- Slow sanity (on-demand): PG vs CH counts + sample verify

### 6.1 Setup

- [x] Add PeerDB to infra (`docker-compose.yml`/k8s)
- [ ] PG config for logical repl (wal_level=logical, slots, WAL retention)
- [x] Create replication user + publication for `articles`,`judgments`

CH currently uses MergeTree + physical deletes. Target: ReplacingMergeTree + soft deletes (Phase 6).

- [x] Create mirrors PG→CH: `forska.articles`, `forska.judgments`
- [ ] Decide snapshot mode + batch/parallelism
- [ ] Type mapping: `text[]` → `Array(String)` (`quotes`, `answeredOriginalAsArray`)
- [ ] Enforce non-null CH `String` cols (no `null` writes)
- [ ] Denorm cols in judgments: keep as-is for now (Phase 5)

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

- [x] Enable logical replication: `wal_level=logical` (`config/postgres/postgresql.conf`)
- [x] Configure `pg_hba.conf` for replication connections (`config/postgres/pg_hba.conf`)
- [x] Run: `bun run scripts/setupPeerdbPostgres.ts` (role+publication+REPLICA IDENTITY; `PEERDB_CREATE_SLOT=1` to also create slot) (ran 2026-01-27; slot: no)

#### 6.2 PeerDB Infrastructure

- [x] Deploy PeerDB stack (Docker Compose profile: `peerdb`) — see `docker-compose.yml`
- [x] S3-compatible storage for staging: SeaweedFS (`peerdb-seaweed-*`), S3 endpoint `http://peerdb-seaweed-s3:8333` (+ `peerdb-s3-bucket-init`)
- [x] Fallback (if needed): MinIO (`docker compose --profile peerdb-minio ...`) + set endpoint `http://peerdb-minio:9000`
- [x] Configure mirror (PG→CH): `bun --env-file=.env.local scripts/setupPeerdbPgToClickhouse.ts`
- [x] Tune (env):
  - `PEERDB_MIRROR_MAX_BATCH_SIZE`
  - `PEERDB_MIRROR_SNAPSHOT_NUM_ROWS_PER_PARTITION`
  - `PEERDB_MIRROR_SNAPSHOT_MAX_PARALLEL_WORKERS`
  - `PEERDB_MIRROR_SNAPSHOT_NUM_TABLES_IN_PARALLEL`

#### 6.3 CH Schema Changes

Current MergeTree → **ReplacingMergeTree** with PeerDB cols:

```sql
CREATE TABLE forska.judgments_raw (
    -- existing cols...
    id String,
    created_at DateTime64(3, 'UTC'),
    updated_at DateTime64(3, 'UTC'),
    -- ... other cols ...

    -- PeerDB cols (required)
    _peerdb_version Int64,
    _peerdb_is_deleted Int8 DEFAULT 0
) ENGINE = ReplacingMergeTree(_peerdb_version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (article_id, prompt_id, model_id, id);
```

- [x] Add `_peerdb_version Int64` col
- [x] Add `_peerdb_is_deleted Int8 DEFAULT 0` col
- [x] Use ReplacingMergeTree(`_peerdb_version`) (PeerDB pattern)
- [x] Keep `quotes` as JSON `Nullable(String)` + parse in query layer
- [x] Keep `articleTitle/*` in `forska.judgments` view (join `articles`)

#### 6.4 Query Layer Changes

Primary path: query a "current state" table populated by a materialized view (no `FINAL`/`argMax` in app queries).

Raw/history table queries must handle dedup + filter deleted:

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
- [ ] Create materialized view + target table for "current state" (latest `_peerdb_version` per `id`, excludes deleted)
- [ ] Switch app queries to "current state" table
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

#### 6.7 Tradeoffs

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

## Legacy Manual Sync (Reference)

- [ ] New judgments appear in CH (check `_peerdb_is_deleted=0`)
- [ ] Updated judgments: new version row exists, `FINAL` returns latest
- [ ] Deleted judgments: `_peerdb_is_deleted=1` row exists, filtered out in queries
- [ ] Same for articles
- [ ] Health check counts match (PG vs CH with FINAL + filter)
- [ ] REPLICA IDENTITY works: delete by non-PK cols propagates correctly
- [ ] Load test: sync 100k+ rows, verify no missing/duplicate after snapshot+CDC handoff
- [ ] Query perf acceptable with FINAL (or argMax pattern works)

---

## Testing Checklist (PeerDB)

- [ ] Insert/update/delete judgment propagates to CH
- [ ] Insert/update/delete article propagates to CH
- [ ] Mirror restart resumes; lag recovers
- [ ] Health endpoint reports lag/slot/mutations without false alarms

## Notes (Keep)

- CH DateTime parsing: UTC; avoid `new Date(str)` and string hacks
- CH delete params: `{id:String}` + `query_params` (no `?`)
- CH deletes are mutations; health checks must tolerate lag

## Scale Notes

- Deletes expensive; batch; monitor `system.mutations`
- Avoid frequent full `COUNT(*)` on big tables; windowed/sampled checks

## Key Files

| File | Purpose |
|------|---------|
| `src/server/routes/AdminInvestigateRoutes.ts` | Sync endpoints, backfill logic |
| `src/services/clickhouse/clickhouseClient.ts` | CH client singleton |
| `src/services/clickhouse/ensureClickhouseArticlesTable.ts` | CH DDL incl. `articles_stats` |
| `scripts/clickhouse-setup.sql` | DDL for judgments + articles + stats |
| `scripts/syncArticlesToClickHouse.ts` | Articles sync |
