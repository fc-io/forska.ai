# Plan: Remove Parquet Dual-Write

## Problem

The Parquet dual-write has reliability issues:

- Records are buffered in memory (batch size 1000, flush every 10s)
- Potential data loss if process crashes before flush
- Complex S3Queue ingestion adds latency and indirection

## Solution

Remove the Parquet dual-write entirely. PostgreSQL is the source of truth; ClickHouse is synced via existing manual backfill routes when needed.

---

## Implementation Checklist

### Server Code

- [ ] `src/agent/judge/storeSinglePromptJudgment.ts`
  - Remove import of `DenormalizedJudgmentAnalytics` (line 5)
  - Remove import of `writeJudgmentAnalyticsToParquet` (line 6)
  - Remove `buildDenormalizedJudgmentAnalyticsRecord` function (lines 18-70)
  - Remove call to `writeJudgmentAnalyticsToParquet` (line 202)
  - Remove `getYearFromDate` and `getQuotesAsJsonString` helpers (lines 10-16)

- [ ] `src/server/index.ts`
  - Remove import of `flushDefaultWriterIfPresent` (line 4)
  - Remove import of `parquetRoutes` (line 23)
  - Remove `.use(parquetRoutes)` (line 70)
  - Remove `flushParquetAndExit` function and SIGINT/SIGTERM handlers (lines 78-95)

- [ ] `src/server/routes/ParquetRoutes.ts`
  - Delete entire file

- [ ] `src/server/routes/AdminInvestigateRoutes.ts`
  - Remove dynamic imports of parquet modules (lines 171-174, 285-288)
  - Remove `parquetConfig` checks and Parquet write calls (lines 174, 204, 288, 318)
  - Remove `/api/admin/parquet-dual-write-status` endpoint (lines 1464-1479)

- [ ] `src/services/parquet/`
  - Delete entire directory:
    - `judgmentsParquetDualWrite.ts`
    - `parquetWriter.ts`
    - `types.ts`
    - `index.ts`

### Client Code

- [ ] `src/app/routes/+admin/+parquet/+index.tsx`
  - Delete entire file

- [ ] `src/app/routes/+admin/+clickhouse-sync/+index.tsx`
  - Remove fetch to `/api/admin/parquet-dual-write-status` (line 42)
  - Remove related UI that displays Parquet status

- [ ] `src/components/Navigation.tsx`
  - Remove link to `/admin/parquet` (line 345)

- [ ] Run `bun run dev:app` to regenerate `src/app/routeTree.gen.ts`

### Scripts

- [ ] `scripts/backfillPostgresToParquet.ts`
  - Delete entire file

- [ ] `scripts/backfillPostgresToParquetFast.ts`
  - Delete entire file

- [ ] `scripts/backfillPostgresToParquetDuckDB.ts`
  - Keep (uses DuckDB directly, doesn't import parquet module)

- [ ] `scripts/backfillFailedS3QueueFiles.ts`
  - Keep (operates on existing S3 files, doesn't import parquet module)

### Optional Cleanup (can defer)

- [ ] `src/services/duckdb/duckdbQuery.ts` (line 81)
  - References parquet path pattern; may want to update or remove DuckDB queries

- [ ] ClickHouse S3Queue pipeline (`forska.judgments_queue`, `forska.judgments_mv`)
  - No longer receives new data; can drop these objects or leave inactive

---

## ClickHouse Sync

ClickHouse data is synced manually via existing backfill routes:

| Route                                                  | Purpose                                     |
| ------------------------------------------------------ | ------------------------------------------- |
| `POST /api/admin/backfill-judgments-to-clickhouse`     | Sync new rows from `max(createdAt)` forward |
| `POST /api/admin/sync-deleted-judgments-to-clickhouse` | Sync soft-deleted rows (tombstones)         |

**For a full resync:** Truncate the ClickHouse table, then run backfill.

### Known Limitations

- **No real-time sync:** ClickHouse data lags behind PostgreSQL until backfill is run
- **Gaps not auto-filled:** Backfill starts from `max(createdAt)`, so gaps from earlier failures require truncate + full resync
- **Deletes require separate sync:** `backfill-judgments-to-clickhouse` only syncs new rows by `createdAt`; run `sync-deleted-judgments-to-clickhouse` to propagate deletes
- **Updates not synced:** `judgeStoreJudgment.ts` can update existing judgments; these updates won't be reflected unless you do a full resync (truncate + backfill)
- **Tombstone bug remains:** Soft deletes use same `createdAt`, causing version ties in ReplacingMergeTree. Analytics may show deleted rows until `OPTIMIZE TABLE forska.judgments FINAL` or full resync
- **Dedup is eventual:** ReplacingMergeTree deduplicates during background merges, not immediately
- **S3Queue pipeline orphaned:** `forska.judgments_queue` and `forska.judgments_mv` will no longer receive data but remain in ClickHouse; can be dropped manually if desired

---

## Rollback

`git revert <commit>` to restore all Parquet code and call sites.
