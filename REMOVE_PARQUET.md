# Plan: Remove Parquet Dual-Write

## Problem

The Parquet dual-write has reliability issues:

- Records are buffered in memory (batch size 1000, flush every 10s)
- Potential data loss if process crashes before flush
- Complex S3Queue ingestion adds latency and indirection

## Solution

Remove the Parquet dual-write entirely. PostgreSQL is the source of truth; ClickHouse is synced via existing manual backfill routes when needed.

---

## Changes

| #   | File                                           | Action     | Description                                                                                  |
| --- | ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| 1   | `src/agent/judge/storeSinglePromptJudgment.ts` | **Edit**   | Remove `writeJudgmentAnalyticsToParquet()` call and related imports/code                     |
| 2   | `src/services/parquet/`                        | **Delete** | Remove entire directory (judgmentsParquetDualWrite.ts, parquetWriter.ts, types.ts, index.ts) |
| 3   | `src/server/routes/adminInvestigateRoutes.ts`  | **Edit**   | Remove Parquet imports and calls (lines 171-174, 204, 285-288, 318)                          |

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
- **Deletes require separate sync:** `backfill-judgments-to-clickhouse` only syncs new rows; run `sync-deleted-judgments-to-clickhouse` to propagate deletes
- **Tombstone bug remains:** Soft deletes use same `createdAt`, causing version ties in ReplacingMergeTree. Analytics may show deleted rows until `OPTIMIZE TABLE forska.judgments FINAL` or full resync.
- **Dedup is eventual:** ReplacingMergeTree deduplicates during background merges, not immediately

---

## Out of Scope

| File                                                       | Reason                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `judgeStoreJudgment.ts`                                    | Legacy multi-prompt path; doesn't write to Parquet today |
| Backfill scripts (`scripts/backfillPostgresToParquet*.ts`) | May need cleanup later, but not blocking                 |

---

## Rollback

`git revert <commit>` to restore Parquet code and call site.
