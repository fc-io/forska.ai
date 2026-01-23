# Plan: Replace Parquet Dual-Write with Direct ClickHouse Insert

## Problem

The Parquet dual-write has reliability issues:

- Records are buffered in memory (batch size 1000, flush every 10s)
- Potential data loss if process crashes before flush
- Complex S3Queue ingestion adds latency and indirection

## Solution

Write directly to ClickHouse after each PostgreSQL insert. This is **best-effort** - not transactional with PostgreSQL. Data can still be lost if ClickHouse is unreachable, but this is acceptable because:

1. PostgreSQL remains the source of truth
2. A full-sync backfill can be run to resync (see "Known Limitations" below)
3. The current Parquet approach has the same reliability model (buffered writes can be lost)

This approach trades **write amplification** (per-row insert) for **simplicity** and **lower latency to visibility** in ClickHouse.

---

## ClickHouse Target

**Table:** `forska.judgments`  
**Engine:** `ReplacingMergeTree(createdAt)` with `ORDER BY (id)`

### Deduplication & Idempotency

- ReplacingMergeTree deduplicates by `id` during background merges, keeping the row with the highest `createdAt`
- Retries are safe: inserting the same judgment twice results in one row after merge
- For immediate dedup in queries, use `FINAL` keyword: `SELECT ... FROM judgments FINAL WHERE deletedAt IS NULL`

### Tombstones (Soft Deletes)

**Current behavior has a bug:** Tombstones reuse the original `createdAt`, so ReplacingMergeTree may keep either row (version tie). This means `WHERE deletedAt IS NULL` is unreliable after merges.

**Options to fix (out of scope for this change):**

1. Use `updatedAt` as the version column instead of `createdAt` (requires DDL change)
2. Set tombstone `createdAt` to `now()` so it always wins (but breaks time-series semantics)
3. Use `FINAL` in all queries (performance cost)
4. Accept eventual consistency and periodically re-sync from PostgreSQL

For now, existing behavior is preserved. Queries already use `FINAL` or accept this limitation.

### Field Conversions Required

| Field                     | TypeScript         | ClickHouse                       | Conversion                                                          |
| ------------------------- | ------------------ | -------------------------------- | ------------------------------------------------------------------- |
| `createdAt`               | `Date`             | `DateTime64(6, 'UTC')`           | Format as `YYYY-MM-DD HH:mm:ss.SSS` (ClickHouse pads to 6 decimals) |
| `deletedAt`               | `Date \| null`     | `Nullable(DateTime64(6, 'UTC'))` | Format or `null`                                                    |
| `articleCreatedAt`        | `Date \| null`     | `Nullable(DateTime64(6, 'UTC'))` | Format or `null`                                                    |
| `articleUpdatedAt`        | `Date \| null`     | `Nullable(DateTime64(6, 'UTC'))` | Format or `null`                                                    |
| `articleTitle`            | `string \| null`   | `String` (non-nullable)          | `null` → `''` (coalesce)                                            |
| `answeredOriginalAsArray` | `string[] \| null` | `Array(Nullable(String))`        | `null` → `[]`                                                       |

**Note:** DateTime64(6) expects microseconds but we format with milliseconds (.SSS). ClickHouse accepts this and zero-pads the remaining digits.

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

const formatDateForClickHouse = (date: Date | null): string | null => {
  if (!date) return null
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`
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
          articleTitle: record.articleTitle ?? '', // Non-nullable in CH
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

## Execution Model

**Awaited, not fire-and-forget.** The caller awaits `writeJudgmentToClickHouse()`, but errors are caught and logged (not thrown). This means:

- The PostgreSQL insert completes before ClickHouse write starts
- ClickHouse write adds latency to the request path (~10ms typical, up to 120s timeout)
- If ClickHouse is slow/down, requests complete but ClickHouse data is lost (logged)
- No background queue means no risk of unbounded memory growth from pending writes

**Why not true fire-and-forget (no await)?**

- Unawaited promises with the 120s default timeout could pile up if ClickHouse is slow
- Backpressure is implicit: if ClickHouse is slow, judgment processing slows (acceptable for this use case)

**Future optimization if needed:** Reduce `request_timeout` for this call to ~5s, or use a bounded async queue.

---

## Known Limitations

### Backfill Route Doesn't Fill Gaps

The existing `/api/admin/backfill-judgments-to-clickhouse` starts from `max(createdAt)` in ClickHouse. If some writes fail but later ones succeed, older gaps won't be filled.

**Workaround:** For a full resync, truncate the ClickHouse table first, or add a new backfill mode that syncs all records regardless of existing data.

**Not addressed in this change** - the current Parquet approach has the same limitation.

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
3. For full resync: truncate ClickHouse table, then run backfill from PostgreSQL
