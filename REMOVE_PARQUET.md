# Plan: Remove Parquet Entirely

## Problem

The Parquet dual-write has reliability issues:

- Records are buffered in memory (batch size 1000, flush every 10s)
- Potential data loss if process crashes before flush
- Complex S3Queue ingestion adds latency and indirection

## Solution

Remove Parquet entirely. PostgreSQL is the source of truth; ClickHouse is synced via existing manual backfill routes when needed.

---

## Implementation Checklist

### Server Code

- [x] `src/agent/judge/storeSinglePromptJudgment.ts`
  - Remove import of `DenormalizedJudgmentAnalytics`
  - Remove import of `writeJudgmentAnalyticsToParquet`
  - Remove `buildDenormalizedJudgmentAnalyticsRecord` function
  - Remove call to `writeJudgmentAnalyticsToParquet`
  - Remove `getYearFromDate` and `getQuotesAsJsonString` helpers

- [x] `src/server/index.ts`
  - Remove import of `flushDefaultWriterIfPresent`
  - Remove import of `parquetRoutes`
  - Remove `.use(parquetRoutes)`
  - Remove `flushParquetAndExit` function and SIGINT/SIGTERM handlers

- [x] `src/server/routes/ParquetRoutes.ts` - Delete entire file

- [x] `src/server/routes/AdminInvestigateRoutes.ts`
  - Remove dynamic imports of parquet modules
  - Remove `parquetConfig` checks and Parquet write calls
  - Remove `/api/admin/parquet-dual-write-status` endpoint

- [x] `src/services/parquet/` - Delete entire directory

- [x] `src/services/duckdb/` - Delete entire directory (only used for Parquet queries)

- [x] `src/services/s3/` - Delete entire directory (only used by Parquet)

### Client Code

- [x] `src/app/routes/+admin/+parquet/` - Delete entire directory

- [x] `src/app/routes/+admin/+clickhouse-sync/+index.tsx`
  - Remove `DualWriteStatus` type
  - Remove `fetchDualWriteStatus` function
  - Remove `dualWriteStatus` signal and its usage
  - Remove entire "Parquet Dual-Write Status" card section
  - Update "How Sync Works" info card - remove Parquet/S3Queue references, update to explain manual backfill

- [x] `src/components/Navigation.tsx`
  - Remove link to `/admin/parquet`

- [x] Regenerate route tree:
  - Run `bun run build`
  - Verify `src/app/routeTree.gen.ts` no longer references parquet routes
  - Commit the updated `routeTree.gen.ts`

### Scripts

- [x] `scripts/backfillPostgresToParquet.ts` - Delete
- [x] `scripts/backfillPostgresToParquetFast.ts` - Delete
- [x] `scripts/backfillPostgresToParquetDuckDB.ts` - Delete
- [x] `scripts/backfillFailedS3QueueFiles.ts` - Delete
- [x] `scripts/validateJudgmentsDualWrite.ts` - Delete

### Dependencies

- [x] `package.json`
  - Remove `@dsnp/parquetjs` dependency
  - Remove `@aws-sdk/client-s3` dependency
  - Remove `"validate:dual-write"` script
  - Run `bun install` to update lockfile

### ClickHouse Cleanup

- [x] Drop S3Queue pipeline (run in ClickHouse):
  ```sql
  DROP VIEW IF EXISTS forska.judgments_mv;
  DROP TABLE IF EXISTS forska.judgments_queue;
  ```

### S3/SeaweedFS Cleanup

- [x] Delete existing Parquet files from S3 bucket:
  ```bash
  aws --endpoint-url <SEAWEEDFS_URL> s3 rm s3://forska-judgments/judgments/ --recursive
  ```

---

## ClickHouse Sync (Post-Removal)

ClickHouse data is synced manually via existing backfill routes:

| Route                                                  | Purpose                                     |
| ------------------------------------------------------ | ------------------------------------------- |
| `POST /api/admin/backfill-judgments-to-clickhouse`     | Sync new rows from `max(createdAt)` forward |
| `POST /api/admin/sync-deleted-judgments-to-clickhouse` | Sync soft-deleted rows (tombstones)         |

**For a full resync:** Truncate the ClickHouse table, then run backfill.

### Known Limitations

- **No real-time sync:** ClickHouse data lags behind PostgreSQL until backfill is run
- **Gaps not auto-filled:** Backfill starts from `max(createdAt)`, so gaps require truncate + full resync
- **Deletes require separate sync:** Run `sync-deleted-judgments-to-clickhouse` to propagate deletes
- **Updates not synced:** `judgeStoreJudgment.ts` can update existing judgments; requires full resync
- **Tombstone bug remains:** Soft deletes use same `createdAt`, causing version ties in ReplacingMergeTree
- **Dedup is eventual:** ReplacingMergeTree deduplicates during background merges, not immediately
