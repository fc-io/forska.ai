# Plan: Replace Parquet Dual-Write with Synchronous ClickHouse Insert

## Problem

The Parquet dual-write has reliability issues:

- Records are buffered in memory (batch size 1000, flush every 10s)
- Potential data loss if process crashes before flush
- Complex S3Queue ingestion adds latency

## Solution

Write directly to ClickHouse after each PostgreSQL insert (synchronous).

---

## Changes

| #   | File                                                   | Action     | Description                                                                                                                       |
| --- | ------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/services/clickhouse/judgmentsClickHouseSync.ts`   | **Create** | New service with `writeJudgmentToClickHouse()` function that inserts a single denormalized judgment record directly to ClickHouse |
| 2   | `src/services/parquet/judgmentsParquetDualWrite.ts:34` | **Edit**   | Change default from `true` to `false` so Parquet is disabled unless explicitly enabled via env var                                |
| 3   | `src/agent/judge/storeSinglePromptJudgment.ts:202`     | **Edit**   | Replace `writeJudgmentAnalyticsToParquet()` call with `writeJudgmentToClickHouse()`                                               |

---

## New Service Details

```ts
// src/services/clickhouse/judgmentsClickHouseSync.ts

// - Imports getClickhouseClient and DenormalizedJudgmentAnalytics type
// - Converts Date fields to ClickHouse format (reusing formatDateForClickHouse pattern)
// - Inserts single record via chClient.insert()
// - Catches and logs errors (non-throwing, like current Parquet behavior)
```

---

## Env Var Behavior After Change

| Env Var                                | Before                     | After        |
| -------------------------------------- | -------------------------- | ------------ |
| `PARQUET_JUDGMENTS_DUAL_WRITE` not set | Enabled (if S3 configured) | **Disabled** |
| `PARQUET_JUDGMENTS_DUAL_WRITE=true`    | Enabled                    | Enabled      |
| `PARQUET_JUDGMENTS_DUAL_WRITE=false`   | Disabled                   | Disabled     |
