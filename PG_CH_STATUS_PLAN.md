# PostgreSQL / ClickHouse Sync Admin UI

## Overview

Admin page to monitor data consistency between PostgreSQL (source of truth) and ClickHouse (analytics replica). Shows row counts for articles and judgments in both databases, with discrepancy detection.

## Architecture

### Incremental Counting with Keyset Watermarks

Instead of running expensive `COUNT(*)` queries on every page load, we:

1. **Store cached counts** in a PostgreSQL table (`pgChSyncStats`)
2. **Track keyset watermarks** using `(updatedAt, id)` tuple to avoid cursor-tie and out-of-order insert issues
3. **Increment counts** by only counting rows newer than the watermark
4. **Refresh on-demand** via admin UI button with progress tracking

### Why Keyset Watermarks?

| Approach                 | First Run       | Subsequent Runs            | Notes                                           |
| ------------------------ | --------------- | -------------------------- | ----------------------------------------------- |
| Full COUNT(\*)           | Slow (scan all) | Slow (scan all)            | Simple but expensive                            |
| Timestamp-only watermark | Slow (scan all) | Fast but **can skip rows** | Cursor-tie issues with same-timestamp inserts   |
| Keyset (updatedAt, id)   | Slow (scan all) | Fast and **reliable**      | Handles ties, out-of-order inserts, and updates |

A keyset watermark is a tuple of `(updatedAt, id)` representing the last row we've counted. On the next run, we count rows WHERE `(updatedAt, id) > (watermark_ts, watermark_id)`.

### Why Counts Are Approximate

Incremental counting **cannot stay perfectly accurate** when rows are updated or deleted:

- A row counted as "active" may later be soft-deleted → `activeCount` is now too high
- A row's `updatedAt` changes → it may be re-counted or missed depending on watermark position

**Therefore:** Treat all incremental counts as **approximations**. The system tracks:

1. **Approximate counts** — fast, incremental, may drift
2. **Periodic full recount** — expensive but accurate, resets drift
3. **uniqExact(id)** — accurate unique count for CH (expensive, on-demand)
4. **max(updatedAt) lag** — detects sync delay independent of count accuracy

---

## Database Schema

### New Table: `pgChSyncStats`

```ts
// src/db/schema.ts

export const pgChSyncStats = pgTable('pg_ch_sync_stats', {
  id: text('id').primaryKey(), // e.g., 'pg_articles', 'ch_articles', 'pg_judgments', 'ch_judgments'

  // Counts (approximate — can drift due to updates/deletes)
  totalCount: bigint('total_count', {mode: 'number'}).notNull().default(0),
  activeCount: bigint('active_count', {mode: 'number'}).notNull().default(0),
  deletedCount: bigint('deleted_count', {mode: 'number'}).notNull().default(0),

  // Accurate unique count (from periodic full recount or uniqExact)
  uniqueCount: bigint('unique_count', {mode: 'number'}),
  uniqueCountAt: timestamp('unique_count_at', {withTimezone: true, mode: 'date'}),

  // Keyset watermark (stored as TEXT to preserve full µs precision)
  // CRITICAL: JS Date loses microseconds; store as ISO string or µs epoch
  watermarkTs: text('watermark_ts'), // ISO8601 with microseconds: '2026-01-24T09:00:00.123456Z'
  watermarkId: text('watermark_id'), // UUID of last row counted

  // Lag tracking (for detecting sync delay)
  maxUpdatedAt: text('max_updated_at'), // latest updatedAt seen (µs precision)

  // Job state (for distributed/crash-safe progress)
  jobStatus: text('job_status').default('idle'), // 'idle' | 'running' | 'completed' | 'error'
  jobStartedAt: timestamp('job_started_at', {withTimezone: true, mode: 'date'}),
  jobCompletedAt: timestamp('job_completed_at', {withTimezone: true, mode: 'date'}),
  jobError: text('job_error'),
  jobCurrentBatch: integer('job_current_batch'),
  jobRowsCounted: bigint('job_rows_counted', {mode: 'number'}),

  // Metadata
  lastUpdatedAt: timestamp('last_updated_at', {withTimezone: true, mode: 'date'}).notNull(),
  lastFullCountAt: timestamp('last_full_count_at', {withTimezone: true, mode: 'date'}),
})
```

### Required Indexes (for performance)

```sql
-- PostgreSQL: Support incremental counting on judgments
CREATE INDEX idx_judgments_updated_id ON judgments (updated_at, id);
CREATE INDEX idx_judgments_deleted_updated ON judgments (deleted_at, updated_at) WHERE deleted_at IS NOT NULL;

-- PostgreSQL: Support incremental counting on articles
CREATE INDEX idx_articles_updated_id ON articles (updated_at, id);
```

**Note:** ClickHouse queries on `updated_at` will scan active partitions unless that column is in ORDER BY. Keep expensive checks (FINAL, uniqExact) scoped to recent partitions or on-demand only.

---

## Handling Scale (Millions of Rows)

### Problem

With millions of articles/judgments:

- **Full count** on first run or reset: ~5-10M rows = minutes of scanning
- **Large incremental gap**: if sync hasn't run in days, could be 100k+ new rows
- **Single query timeout**: long-running queries block connections and can timeout

### Solution: Batched Incremental Counting with Locking

Never count more than `BATCH_SIZE` (e.g., 50,000) rows in a single query. Use database-level locking to prevent concurrent runs and double-counting.

```ts
const BATCH_SIZE = 50_000

const countInBatches = async (table: 'articles' | 'judgments', db: DrizzleClient) => {
  const statsId = `pg_${table}`

  // Acquire lock and set job status atomically
  // This prevents concurrent refreshes from double-counting
  const lockAcquired = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({jobStatus: pgChSyncStats.jobStatus})
      .from(pgChSyncStats)
      .where(eq(pgChSyncStats.id, statsId))
      .for('update') // Row-level lock

    if (current?.jobStatus === 'running') {
      return false // Another job is running
    }

    await tx
      .update(pgChSyncStats)
      .set({jobStatus: 'running', jobStartedAt: new Date(), jobCurrentBatch: 0, jobRowsCounted: 0, jobError: null})
      .where(eq(pgChSyncStats.id, statsId))

    return true
  })

  if (!lockAcquired) {
    return {success: false, reason: 'Job already running'}
  }

  try {
    // Load current watermark
    const [stats] = await db
      .select({watermarkTs: pgChSyncStats.watermarkTs, watermarkId: pgChSyncStats.watermarkId})
      .from(pgChSyncStats)
      .where(eq(pgChSyncStats.id, statsId))

    let currentWatermark = {ts: stats?.watermarkTs, id: stats?.watermarkId}
    let batchNumber = 0

    while (true) {
      batchNumber++

      // CRITICAL: Get batch data + new watermark in ONE query over same predicate
      // This prevents skipping rows inserted between count and watermark queries
      const batch = await db
        .select({
          id: article.id,
          updatedAt: sql<string>`to_char(${article.updatedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          deletedAt: article.deletedAt,
        })
        .from(article)
        .where(
          currentWatermark.ts
            ? or(
                gt(article.updatedAt, sql`${currentWatermark.ts}::timestamptz`),
                and(
                  eq(article.updatedAt, sql`${currentWatermark.ts}::timestamptz`),
                  gt(article.id, currentWatermark.id),
                ),
              )
            : undefined,
        )
        .orderBy(asc(article.updatedAt), asc(article.id))
        .limit(BATCH_SIZE)

      if (batch.length === 0) break

      const activeInBatch = batch.filter((r) => r.deletedAt === null).length
      const deletedInBatch = batch.length - activeInBatch
      const lastRow = batch[batch.length - 1]
      const newWatermark = {ts: lastRow.updatedAt, id: lastRow.id}

      // Atomic update: counts + watermark + progress in single transaction
      await db.transaction(async (tx) => {
        await tx
          .update(pgChSyncStats)
          .set({
            totalCount: sql`${pgChSyncStats.totalCount} + ${batch.length}`,
            activeCount: sql`${pgChSyncStats.activeCount} + ${activeInBatch}`,
            deletedCount: sql`${pgChSyncStats.deletedCount} + ${deletedInBatch}`,
            watermarkTs: newWatermark.ts,
            watermarkId: newWatermark.id,
            maxUpdatedAt: sql`GREATEST(${pgChSyncStats.maxUpdatedAt}, ${newWatermark.ts})`,
            jobCurrentBatch: batchNumber,
            jobRowsCounted: sql`${pgChSyncStats.jobRowsCounted} + ${batch.length}`,
            lastUpdatedAt: new Date(),
          })
          .where(eq(pgChSyncStats.id, statsId))
      })

      currentWatermark = newWatermark
      await Bun.sleep(100) // Rate limit
    }

    // Mark job complete
    await db
      .update(pgChSyncStats)
      .set({jobStatus: 'completed', jobCompletedAt: new Date()})
      .where(eq(pgChSyncStats.id, statsId))

    return {success: true}
  } catch (error) {
    // Mark job failed
    await db
      .update(pgChSyncStats)
      .set({jobStatus: 'error', jobError: String(error), jobCompletedAt: new Date()})
      .where(eq(pgChSyncStats.id, statsId))

    throw error
  }
}
```

### Key Properties

| Property                       | How It's Handled                                                        |
| ------------------------------ | ----------------------------------------------------------------------- |
| **Concurrent runs**            | Row-level lock via `FOR UPDATE`; second caller gets "already running"   |
| **Crash recovery**             | Watermark persisted after each batch; job stays "running" until timeout |
| **Double-counting prevention** | Watermark advanced atomically with count increment in same transaction  |
| **µs precision**               | Timestamps stored as ISO strings via `to_char(..., 'US')`               |
| **Progress visibility**        | `jobCurrentBatch` and `jobRowsCounted` updated after each batch         |

### Stale Job Detection

If `jobStatus = 'running'` but `jobStartedAt` is >30 min ago, consider the job crashed and allow restart:

```ts
const isStaleJob = (stats: PgChSyncStats) =>
  stats.jobStatus === 'running' && stats.jobStartedAt && Date.now() - stats.jobStartedAt.getTime() > 30 * 60 * 1000
```

### Estimated Times (with index)

| Rows to Count | Batches | Est. Time |
| ------------- | ------- | --------- |
| 10,000        | 1       | ~2s       |
| 100,000       | 2       | ~5s       |
| 1,000,000     | 20      | ~45s      |
| 5,000,000     | 100     | ~4min     |

_Times assume indexed keyset queries (~50ms per batch) + 100ms sleep._

---

## API Endpoints

### `GET /api/admin/sync-stats`

Returns current cached counts and health metrics from `pgChSyncStats` table.

```ts
// Response
{
  stats: {
    articles: {
      pg: {
        total: 1234567,        // approximate
        active: 1234567,       // approximate
        deleted: 0,            // approximate
        uniqueCount: 1234567,  // accurate (from last full recount)
        uniqueCountAge: '2d',  // how old is uniqueCount
        maxUpdatedAt: '2026-01-24T10:00:00.123456Z',
      },
      ch: {
        total: 1234650,        // may be > PG due to unmerged duplicates
        active: 1234500,
        deleted: 150,
        uniqueCount: 1234500,  // from uniqExact (on-demand)
        maxUpdatedAt: '2026-01-24T09:30:00.456789Z',
        dedupDrift: 150,       // total - uniqueCount
      },
      // Comparison
      diff: {
        absolute: -83,         // negative = CH ahead (unmerged dups)
        percentage: -0.007,
        direction: 'ch_ahead', // 'pg_ahead' | 'ch_ahead' | 'synced'
      },
      lag: {
        seconds: 1800,         // CH maxUpdatedAt is 30min behind PG
        formatted: '30 min',
      },
      status: 'merge_pending', // see Status Thresholds
    },
    judgments: { /* same structure */ },
  },
  // Job progress (persisted in DB, survives restarts)
  jobs: {
    pg_articles: { status: 'idle' },
    pg_judgments: { status: 'running', currentBatch: 15, rowsCounted: 750000, startedAt: '...' },
    ch_articles: { status: 'completed', completedAt: '...' },
    ch_judgments: { status: 'error', error: 'Connection refused' },
  },
}
```

### `POST /api/admin/refresh-sync-stats`

Triggers incremental count update. Returns immediately, runs async.

```ts
// Request body (optional)
{
  tables?: ('pg_articles' | 'ch_articles' | 'pg_judgments' | 'ch_judgments')[],
  fullRecount?: boolean,       // Reset watermark, recount from scratch
  includeUniqueCount?: boolean, // Run expensive uniqExact for accurate count
}

// Response
{ started: true, message: 'Sync stats refresh started' }
// OR
{ started: false, reason: 'Job already running for pg_judgments' }
```

### `GET /api/admin/refresh-sync-stats-progress`

Poll for progress during refresh. **Progress is read from DB**, so it survives restarts and works across multiple server instances.

```ts
// Response (derived from pgChSyncStats.job* columns)
{
  jobs: {
    pg_articles: { status: 'completed', rowsCounted: 50000 },
    pg_judgments: {
      status: 'running',
      currentBatch: 15,
      rowsCounted: 750000,
      startedAt: '2026-01-24T10:00:00Z',
      elapsedSeconds: 45,
    },
    ch_articles: { status: 'idle' },
    ch_judgments: { status: 'idle' },
  },
}
```

### `POST /api/admin/sample-verify`

Spot-check N random rows for data integrity.

```ts
// Request body
{
  table: 'articles' | 'judgments',
  sampleSize?: number, // default: 100
  sampleType?: 'recent' | 'random' | 'deleted', // default: 'recent'
}

// Response
{
  sampled: 100,
  matched: 98,
  missingInCh: ['id1', 'id2'],
  missingInPg: [],
  fieldMismatches: [{ id: 'id3', field: 'articleTitle', pg: 'Title A', ch: 'Title B' }],
}
```

---

## Counting Logic

### ClickHouse Articles (snake_case columns)

**IMPORTANT:** The `forska.articles` table uses snake_case column names (`updated_at`, `created_at`, `import_route`), not camelCase.

```ts
// Basic incremental count for CH articles
const result = await clickhouseClient.query({
  query: `
    SELECT
      count(*) as totalCount,
      uniqExact(id) as uniqueCount,
      max(updated_at) as maxUpdatedAt
    FROM forska.articles
    WHERE (updated_at, id) > ({watermarkTs:DateTime64(6, 'UTC')}, {watermarkId:String})
  `,
  query_params: {watermarkTs: currentWatermarkTs, watermarkId: currentWatermarkId},
})
```

### ClickHouse Judgments (camelCase columns)

```ts
// Basic count for CH judgments
const result = await clickhouseClient.query({
  query: `
    SELECT
      count(*) as totalCount,
      countIf(deletedAt IS NULL) as activeCount,
      countIf(deletedAt IS NOT NULL) as deletedCount,
      max(updatedAt) as maxUpdatedAt
    FROM forska.judgments
    WHERE (updatedAt, id) > ({watermarkTs:DateTime64(6, 'UTC')}, {watermarkId:String})
  `,
  query_params: {watermarkTs: currentWatermarkTs, watermarkId: currentWatermarkId},
})

// Accurate unique count (expensive - on-demand only, scope to recent partitions)
const uniqueResult = await clickhouseClient.query({
  query: `
    SELECT uniqExact(id) as uniqueCount
    FROM forska.judgments
    -- Optionally scope to recent data for performance:
    -- WHERE createdAt >= now() - INTERVAL 30 DAY
  `,
})
```

### Handling Deletions & ReplacingMergeTree

ClickHouse's ReplacingMergeTree is **eventually consistent** — tombstones may not be merged immediately. This causes:

1. **CH count > PG count**: unmerged duplicates inflate `count(*)`
2. **CH count < PG count**: sync lag (rows not yet synced)

**Display logic:**

| Condition           | Status          | Meaning                   |
| ------------------- | --------------- | ------------------------- |
| CH total > PG total | `merge_pending` | Unmerged duplicates in CH |
| CH total < PG total | `behind`        | Sync lag                  |
| CH total ≈ PG total | `synced`        | Healthy                   |

**Mitigations:**

- Always show `dedupDrift` = `count(*) - uniqExact(id)` when available
- Use `FINAL` modifier sparingly (expensive) for accurate counts
- Show "approximate" label on all counts
- Track `maxUpdatedAt` lag as primary health indicator (more reliable than count diff)

---

## Status Thresholds

| Condition                                         | Status        | Badge Color | Meaning            |
| ------------------------------------------------- | ------------- | ----------- | ------------------ |
| lag < 1h AND \|diff\| < 0.1% AND dedupDrift < 100 | Synced        | Green       | Healthy            |
| lag 1-6h OR \|diff\| 0.1-1%                       | Behind        | Yellow      | Minor lag          |
| lag > 6h OR \|diff\| > 1%                         | Critical      | Red         | Needs attention    |
| CH total > PG total + 1000                        | Merge Pending | Orange      | Run OPTIMIZE TABLE |
| CH unreachable                                    | Unreachable   | Gray        | Connection error   |
| PG count = 0                                      | Empty         | Gray        | No data            |

**Display both absolute and percentage:**

```
Diff: 8,901 rows (0.16%) — CH behind
Diff: -150 rows (-0.01%) — CH ahead (merge pending)
```

---

## UI Components

### Admin Page: `/admin/sync-stats`

```
+------------------------------------------------------------------+
|  Database Sync Status                            [Refresh] [Full] |
+------------------------------------------------------------------+
|                                                                  |
|  +-----------------------------+  +-----------------------------+ |
|  | ARTICLES                    |  | JUDGMENTS                   | |
|  |                             |  |                             | |
|  | PostgreSQL (approx)         |  | PostgreSQL (approx)         | |
|  |   Total:  1,234,567         |  |   Total:  5,678,901         | |
|  |   Unique: 1,234,567 (2d ago)|  |   Active: 5,600,000         | |
|  |   Max updated: 10:00:00     |  |   Deleted: 78,901           | |
|  |                             |  |   Max updated: 10:00:00     | |
|  | ClickHouse (approx)         |  |                             | |
|  |   Total:  1,234,650         |  | ClickHouse (approx)         | |
|  |   Unique: 1,234,500         |  |   Total:  5,670,150         | |
|  |   Dedup drift: 150          |  |   Active: 5,592,000         | |
|  |   Max updated: 09:30:00     |  |   Deleted: 78,000           | |
|  |                             |  |   Unique: 5,670,000         | |
|  | Diff: -83 (-0.01%) CH ahead |  |   Dedup drift: 150          | |
|  | Lag: 30 min                 |  |   Max updated: 09:00:00     | |
|  | Status: [MERGE PENDING]     |  |                             | |
|  +-----------------------------+  | Diff: 8,901 (0.16%) behind  | |
|                                   | Lag: 1 hour                 | |
|                                   | Status: [CRITICAL]          | |
|                                   +-----------------------------+ |
|                                                                  |
|  Last updated: 2 minutes ago                                     |
|                                                                  |
|  Jobs:                                                           |
|  pg_articles:  [IDLE]                                            |
|  pg_judgments: [RUNNING] Batch 15 — 750,000 rows (45s elapsed)   |
|  ch_articles:  [COMPLETED] 50,000 rows                           |
|  ch_judgments: [ERROR] Connection refused                        |
|                                                                  |
|  [Sample Verify Articles] [Sample Verify Judgments]              |
|                                                                  |
+------------------------------------------------------------------+
```

---

## Implementation Tasks

### Phase 1: Database & API

1. [ ] Add `pgChSyncStats` table to Drizzle schema (with job\* columns)
2. [ ] Generate and run migration
3. [ ] Add indexes for `(updatedAt, id)` on articles and judgments
4. [ ] Create `GET /api/admin/sync-stats` endpoint
5. [ ] Create `POST /api/admin/refresh-sync-stats` with DB-persisted job state
6. [ ] Create `GET /api/admin/refresh-sync-stats-progress` (reads from DB)
7. [ ] Implement batched counting with row-level locking
8. [ ] Implement lag tracking (max updatedAt comparison)
9. [ ] Handle CH articles snake_case vs judgments camelCase

### Phase 2: Admin UI

10. [ ] Create `/admin/sync-stats` page
11. [ ] Add cards showing total/unique/deleted breakdown
12. [ ] Show both absolute diff AND percentage
13. [ ] Show "CH ahead" vs "CH behind" direction
14. [ ] Show lag time and dedup drift
15. [ ] Add job status indicators with batch progress
16. [ ] Add refresh button (disabled if job running)
17. [ ] Add "Full Recount" option

### Phase 3: Verification & Polish

18. [ ] Implement `POST /api/admin/sample-verify` endpoint
19. [ ] Add sample verify UI with results display
20. [ ] Add stale job detection (>30min running = crashed)
21. [ ] Add logging for debugging
22. [ ] Consider scheduled refresh (cron) if needed

---

## File Structure

```
src/
├── db/
│   └── schema.ts                    # Add pgChSyncStats table
├── server/
│   └── routes/
│       └── adminSyncStatsRoutes.ts  # New route file
├── app/
│   └── routes/
│       └── +admin/
│           └── +sync-stats/
│               └── +index.tsx       # Admin UI page
```

---

## Edge Cases

1. **First run (no watermark)**: Full count in batches, set initial watermark
2. **ClickHouse unreachable**: Show "Unreachable" status, use cached count
3. **Count goes down (deletes/updates)**: Expected — counts are approximate; use periodic full recount
4. **CH count > PG count**: Unmerged duplicates; show as "merge pending", not error
5. **Concurrent refresh attempts**: Row-level lock returns "already running"
6. **Crashed job**: Detect via stale `jobStartedAt`; allow manual restart
7. **µs precision**: Store as ISO string with `to_char(..., 'US')`, never JS Date
8. **Multi-instance deployment**: Job state in DB, not memory; all instances see same progress

---

## Future Enhancements

- Scheduled background refresh (every 15 min)
- Historical tracking (count over time chart)
- Per-project breakdown
- Alert notifications when diff exceeds threshold
- Automatic OPTIMIZE TABLE trigger when dedup drift exceeds threshold
- Job queue (pg-boss) for more robust background processing
