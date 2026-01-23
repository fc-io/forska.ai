# Plan: Replace Parquet Dual-Write with Direct ClickHouse Insert

## Problem

The Parquet dual-write has reliability issues:

- Records are buffered in memory (batch size 1000, flush every 10s)
- Potential data loss if process crashes before flush
- Complex S3Queue ingestion adds latency and indirection

## Solution

Write directly to ClickHouse after each PostgreSQL insert. This is **best-effort** (fire-and-forget) - not transactional with PostgreSQL. Data can still be lost if ClickHouse is unreachable, but this is acceptable because:

1. PostgreSQL remains the source of truth
2. Existing backfill route (`/api/admin/backfill-judgments-to-clickhouse`) can resync any missing data
3. The current Parquet approach has the same reliability model (buffered writes can be lost)

This approach trades **write amplification** (per-row insert) for **simplicity** and **lower latency to visibility** in ClickHouse.

---

## ClickHouse Target

**Table:** `forska.judgments`  
**Engine:** `ReplacingMergeTree(createdAt)` with `ORDER BY (id)`

### Deduplication & Idempotency

- ReplacingMergeTree deduplicates by `id` during background merges, keeping the row with the highest `createdAt`
- Retries are safe: inserting the same judgment twice results in one row after merge
- Soft deletes (tombstones): insert a record with the same `id` but `deletedAt` set; queries filter via `WHERE deletedAt IS NULL`
- For immediate dedup in queries, use `FINAL` keyword: `SELECT ... FROM judgments FINAL WHERE deletedAt IS NULL`

### Field Conversions Required

| Field                     | TypeScript         | ClickHouse                       | Conversion                          |
| ------------------------- | ------------------ | -------------------------------- | ----------------------------------- |
| `createdAt`               | `Date`             | `DateTime64(6, 'UTC')`           | Format as `YYYY-MM-DD HH:mm:ss.SSS` |
| `deletedAt`               | `Date \| null`     | `Nullable(DateTime64(6, 'UTC'))` | Format or `null`                    |
| `articleCreatedAt`        | `Date \| null`     | `Nullable(DateTime64(6, 'UTC'))` | Format or `null`                    |
| `articleUpdatedAt`        | `Date \| null`     | `Nullable(DateTime64(6, 'UTC'))` | Format or `null`                    |
| `answeredOriginalAsArray` | `string[] \| null` | `Array(Nullable(String))`        | `null` → `[]`                       |

---

## Scope

### In Scope (this change)

| #   | File                                                   | Action     | Description                                                              |
| --- | ------------------------------------------------------ | ---------- | ------------------------------------------------------------------------ |
| 1   | `src/services/clickhouse/judgmentsClickHouseSync.ts`   | **Create** | New service: `writeJudgmentToClickHouse()` inserts to `forska.judgments` |
| 2   | `src/services/parquet/judgmentsParquetDualWrite.ts:34` | **Edit**   | Change default from `true` to `false`                                    |
| 3   | `src/agent/judge/storeSinglePromptJudgment.ts:202`     | **Edit**   | Replace Parquet call with ClickHouse call                                |

### Out of Scope (not changed)

| File                                                       | Reason                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `judgeStoreJudgment.ts`                                    | Legacy multi-prompt path; doesn't write to Parquet today, so no regression. Should be migrated separately.       |
| `adminInvestigateRoutes.ts:204`                            | Writes tombstones for deleted judgments; already has ClickHouse fallback at line 208-238. Will continue working. |
| Backfill scripts (`scripts/backfillPostgresToParquet*.ts`) | Used for bulk historical sync; can be updated separately if needed.                                              |

---

## New Service Details

```ts
// src/services/clickhouse/judgmentsClickHouseSync.ts

import {getClickhouseClient} from './clickhouseClient'
import type {DenormalizedJudgmentAnalytics} from '../parquet/types'

// Format: YYYY-MM-DD HH:mm:ss.SSS (ClickHouse DateTime64(6) expects this)
const formatDateForClickHouse = (date: Date | null): string | null => {
  if (!date) return null
  // ... UTC formatting logic (same as adminInvestigateRoutes.ts:358-368)
}

export const writeJudgmentToClickHouse = async (record: DenormalizedJudgmentAnalytics): Promise<void> => {
  try {
    const chClient = getClickhouseClient()
    await chClient.insert({
      table: 'forska.judgments',
      values: [
        {
          ...record,
          createdAt: formatDateForClickHouse(record.createdAt),
          deletedAt: formatDateForClickHouse(record.deletedAt),
          articleCreatedAt: formatDateForClickHouse(record.articleCreatedAt),
          articleUpdatedAt: formatDateForClickHouse(record.articleUpdatedAt),
          answeredOriginalAsArray: record.answeredOriginalAsArray ?? [],
        },
      ],
      format: 'JSONEachRow',
    })
  } catch (error) {
    // Best-effort: log and continue, don't throw
    console.error('[ClickHouse Sync] Failed to write judgment', {
      id: record.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
```

---

## Performance Considerations

**Tradeoff:** Per-row `chClient.insert()` adds latency to the judgment write path.

**Acceptable because:**

- Judgment writes are already I/O-bound (PostgreSQL insert + LLM response handling)
- ClickHouse HTTP insert for a single row is typically <10ms
- Fire-and-forget (async in request handler) means it doesn't block response
- If latency becomes an issue, can batch writes using a small in-memory buffer with immediate flush (vs current 10s/1000-record buffer)

**Alternative considered but deferred:**

- Outbox pattern (write to PG outbox table, background worker syncs to ClickHouse) - more complex, not needed given backfill exists

---

## Env Var Behavior After Change

| Env Var                                | Before                     | After                         |
| -------------------------------------- | -------------------------- | ----------------------------- |
| `PARQUET_JUDGMENTS_DUAL_WRITE` not set | Enabled (if S3 configured) | **Disabled**                  |
| `PARQUET_JUDGMENTS_DUAL_WRITE=true`    | Enabled                    | Enabled                       |
| `PARQUET_JUDGMENTS_DUAL_WRITE=false`   | Disabled                   | Disabled                      |
| Invalid value (e.g., `yes`, `1`)       | Treated as not set         | Treated as not set (disabled) |

**Note:** Invalid boolean values are ignored (not `true` or `false` after lowercase/trim) and behave as "not set".

---

## Rollback

If issues arise:

1. Set `PARQUET_JUDGMENTS_DUAL_WRITE=true` to re-enable Parquet path
2. The ClickHouse sync call will still run but can be removed in a follow-up
3. Run backfill to sync any missing records: `POST /api/admin/backfill-judgments-to-clickhouse`
