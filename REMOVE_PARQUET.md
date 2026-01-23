# Plan: Remove Parquet Dual-Write

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

- [ ] `src/services/duckdb/duckdbQuery.ts`
  - Remove or update Parquet path reference (line 81)

### Client Code

- [ ] `src/app/routes/+admin/+parquet/`
  - Delete entire directory (including `+index.tsx`)

- [ ] `src/app/routes/+admin/+clickhouse-sync/+index.tsx`
  - Remove fetch to `/api/admin/parquet-dual-write-status` (line 42)
  - Remove related UI that displays Parquet status

- [ ] `src/components/Navigation.tsx`
  - Remove link to `/admin/parquet` (line 345)

- [ ] Regenerate route tree:
  - Run `bun run build` (or `bun run dev:app` and wait for regeneration)
  - Verify `src/app/routeTree.gen.ts` no longer references parquet routes
  - Commit the updated `routeTree.gen.ts`

### Scripts

- [ ] `scripts/backfillPostgresToParquet.ts` - Delete
- [ ] `scripts/backfillPostgresToParquetFast.ts` - Delete
- [ ] `scripts/backfillPostgresToParquetDuckDB.ts` - Delete
- [ ] `scripts/backfillFailedS3QueueFiles.ts` - Delete

### Dependencies

- [ ] `package.json`
  - Remove `@dsnp/parquetjs` dependency (line 71)
  - Run `bun install` to update lockfile

### ClickHouse Cleanup

- [ ] Drop S3Queue pipeline (run in ClickHouse):
  ```sql
  DROP VIEW IF EXISTS forska.judgments_mv;
  DROP TABLE IF EXISTS forska.judgments_queue;
  ```

### S3/SeaweedFS Cleanup

- [ ] Delete existing Parquet files from S3 bucket:

  ```bash
  # List files first
  aws --endpoint-url <SEAWEEDFS_URL> s3 ls s3://forska-judgments/judgments/ --recursive

  # Delete all parquet files
  aws --endpoint-url <SEAWEEDFS_URL> s3 rm s3://forska-judgments/judgments/ --recursive
  ```

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

---

## Rollback

`git revert <commit>` to restore all Parquet code. Manual steps to restore:

- Reinstall `@dsnp/parquetjs`: `bun add @dsnp/parquetjs`
- Recreate ClickHouse S3Queue objects (from `scripts/clickhouse-setup.sql`)
