# Plan: Remove Parquet Dual-Write

## Problem

The Parquet dual-write has reliability issues:

- Records are buffered in memory (batch size 1000, flush every 10s)
- Potential data loss if process crashes before flush
- Complex S3Queue ingestion adds latency and indirection

## Solution

Remove the Parquet dual-write entirely. PostgreSQL is the source of truth; ClickHouse is synced via the existing manual backfill route when needed.

---

## Changes

| #   | File                                                   | Action   | Description                                     |
| --- | ------------------------------------------------------ | -------- | ----------------------------------------------- |
| 1   | `src/services/parquet/judgmentsParquetDualWrite.ts:34` | **Edit** | Change default from `true` to `false`           |
| 2   | `src/agent/judge/storeSinglePromptJudgment.ts:202`     | **Edit** | Remove `writeJudgmentAnalyticsToParquet()` call |

---

## ClickHouse Sync

ClickHouse data is synced manually via the existing backfill route:

```
POST /api/admin/backfill-judgments-to-clickhouse
```

This syncs from `max(createdAt)` in ClickHouse forward. For a full resync, truncate the ClickHouse table first.

### Known Limitations

- **No real-time sync:** ClickHouse data lags behind PostgreSQL until backfill is run
- **Gaps not auto-filled:** Backfill starts from `max(createdAt)`, so gaps from earlier failures won't heal (requires truncate + full resync)
- **Tombstone bug remains:** Soft deletes use same `createdAt`, causing version ties in ReplacingMergeTree. Analytics may show deleted rows until `OPTIMIZE TABLE forska.judgments FINAL` or full resync.
- **Dedup is eventual:** ReplacingMergeTree deduplicates during background merges, not immediately

---

## Out of Scope

| File                            | Reason                                                   |
| ------------------------------- | -------------------------------------------------------- |
| `judgeStoreJudgment.ts`         | Legacy multi-prompt path; doesn't write to Parquet today |
| `adminInvestigateRoutes.ts:204` | Writes tombstones; already has ClickHouse fallback       |
| Backfill scripts                | Used for bulk sync; still work, can update separately    |
| Parquet service code            | Kept but disabled; may be useful for other purposes      |

---

## Env Var Behavior After Change

| Env Var                                | Before                     | After        |
| -------------------------------------- | -------------------------- | ------------ |
| `PARQUET_JUDGMENTS_DUAL_WRITE` not set | Enabled (if S3 configured) | **Disabled** |
| `PARQUET_JUDGMENTS_DUAL_WRITE=true`    | Enabled                    | Enabled      |
| `PARQUET_JUDGMENTS_DUAL_WRITE=false`   | Disabled                   | Disabled     |

---

## Rollback

1. `git revert <commit>` to restore Parquet call
2. Set `PARQUET_JUDGMENTS_DUAL_WRITE=true` if needed
