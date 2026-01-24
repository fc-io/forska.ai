# PostgreSQL / ClickHouse Sync Admin UI

## Overview

Admin page to monitor data consistency between PostgreSQL (source of truth) and ClickHouse (analytics replica). Shows row counts for articles and judgments in both databases, with discrepancy detection.

## Key Design Decisions

This plan addresses several subtle correctness and performance issues:

| Issue                                                            | Solution                                             | Section                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Timestamp-only watermark skips rows on ties                      | Keyset `(updatedAt, id)` tuple                       | [Why Keyset Watermarks](#why-keyset-watermarks)                         |
| Retroactive timestamps bypass watermark                          | Document limitation + periodic full recount          | [Keyset Limitation](#why-keyset-watermarks)                             |
| `totalCount` inflates on updates (re-counting)                   | Use `uniqueCount` for alerts/diffs, not `totalCount` | [Why Counts Are Approximate](#why-counts-are-approximate)               |
| `to_char(..., 'Z')` emits local time                             | Use `AT TIME ZONE 'UTC'`                             | [Batched Counting](#solution-batched-incremental-counting-with-locking) |
| `GREATEST` on nullable text stays NULL                           | Use `COALESCE` with conditional                      | [Batched Counting](#solution-batched-incremental-counting-with-locking) |
| Stale job detection using start time misclassifies long recounts | Heartbeat-based detection via `lastUpdatedAt`        | [Stale Job Detection](#stale-job-detection-heartbeat-based)             |
| Missing `pgChSyncStats` seed rows makes locks no-op              | Seed/upsert 4 rows before refresh                    | [Batched Counting](#solution-batched-incremental-counting-with-locking) |
| Articles table has no `deleted_at` column                        | Table-specific config (`TABLE_CONFIG`)               | [Batched Counting](#solution-batched-incremental-counting-with-locking) |
| CH judgments lacks `updatedAt` column                            | Feature flag + fallback to `createdAt`               | [ClickHouse Judgments](#clickhouse-judgments-camelcase-columns)         |
| Cursor col switch (`createdAt`→`updatedAt`) breaks watermarks    | Persist cursor col + force full recount on change    | [ClickHouse Judgments](#clickhouse-judgments-camelcase-columns)         |
| `uniqExact()` expensive on large tables                          | Default to `uniqCombined()`, exact on-demand         | [ClickHouse Judgments](#clickhouse-judgments-camelcase-columns)         |
| `uniqCombined()` error conflicts with tight thresholds           | Widen thresholds unless exact counts                 | [Status Thresholds](#status-thresholds)                                 |
| Fetching 50k rows per batch wastes bandwidth                     | CTE computes counts in-database                      | [Batched Counting](#solution-batched-incremental-counting-with-locking) |
| CH keyset WHERE can full-scan (ORDER BY/partition mismatch)      | Default to full `count()`; keyset only if aligned    | [Counting Logic](#counting-logic)                                       |
| Single-column index causes heap fetches                          | Composite covering index with `INCLUDE`              | [Required Indexes](#required-indexes-for-performance)                   |
| Lag alone misses old partition gaps                              | Partition coverage check endpoint                    | [Partition Coverage Check](#post-apiadminpartition-coverage-check)      |
| PG month query risk (string INTERVAL, TZ drift)                  | `make_interval` + `AT TIME ZONE 'UTC'`               | [Partition Coverage Check](#post-apiadminpartition-coverage-check)      |
| Sample-verify gets false mismatches during merge                 | Use `FINAL` or `argMax` for CH queries               | [Sample Verify](#post-apiadminsample-verify)                            |
| `OPTIMIZE TABLE FINAL` blocks production                         | Partition-scoped or avoid entirely                   | [ClickHouse Judgments](#clickhouse-judgments-camelcase-columns)         |

## Dependencies

- **PG_CH_HEALTH.md Phase-1:** CH judgments `updatedAt` needed for update-lag + `argMax` correctness. Until then, show insert-lag only (`createdAt`).
- **PG_CH_HEALTH.md Phase-5:** `scripts/syncArticlesToClickHouse.ts` should be keyset `(updated_at, id)` (no OFFSET) for correctness/perf at 10M+ rows.

## Architecture

### Incremental Counting with Keyset Watermarks

Instead of running expensive `COUNT(*)` queries on every page load, we:

1. **Store cached counts** in a PostgreSQL table (`pgChSyncStats`)
2. **PG:** keyset watermark + batched scans (cheap incremental)
3. **CH:** `count()` + `max()` on refresh (cheap); `uniqCombined/uniqExact` on-demand
4. **Refresh on-demand** via admin UI button with progress tracking

### Why Keyset Watermarks?

| Approach                 | First Run       | Subsequent Runs            | Notes                                           |
| ------------------------ | --------------- | -------------------------- | ----------------------------------------------- |
| Full COUNT(\*)           | Slow (scan all) | Slow (scan all)            | Simple but expensive                            |
| Timestamp-only watermark | Slow (scan all) | Fast but **can skip rows** | Cursor-tie issues with same-timestamp inserts   |
| Keyset (updatedAt, id)   | Slow (scan all) | Fast and **reliable\***    | Handles ties, out-of-order inserts, and updates |

A keyset watermark is a tuple of `(updatedAt, id)` representing the last row we've counted. On the next run, we count rows WHERE `(updatedAt, id) > (watermark_ts, watermark_id)`.

**\*Keyset Limitation — Non-Monotonic Timestamps:**

Keyset pagination assumes `updatedAt` increases monotonically. Rows with **retroactive timestamps** (e.g., backfills with historical `updatedAt`) will be **permanently skipped** if they fall before the current watermark.

**Mitigations:**

1. **Backfill detection:** Before inserting rows with `updatedAt < NOW() - 1 hour`, set a flag that triggers a full recount
2. **Periodic full recount:** Schedule weekly/monthly full recounts to correct any drift
3. **Watermark reset on schema changes:** Any migration touching `updated_at` should reset watermarks
4. **Admin UI warning:** Show "approximate" label and age of last full recount

### Why Counts Are Approximate

Incremental counting **cannot stay perfectly accurate** when rows are updated or deleted:

- A row counted as "active" may later be soft-deleted → `activeCount` is now too high
- A row's `updatedAt` changes → it gets **re-counted** (inflating `totalCount`)
- Deletes are not subtracted — we only add, never subtract

**Critical:** `totalCount` can **only grow** and will inflate over time as rows are updated. This makes `totalCount` unsuitable for diff/threshold alerts.

**Therefore:** Treat all incremental counts as **approximations**. The system tracks:

1. **Approximate counts** — fast, incremental, **inflate on updates** (use for progress indication only)
2. **Periodic full recount** — expensive but accurate, resets drift
3. **`uniqueCount`** — accurate unique count (from full recount or `uniqExact`), **use this for alerts/diffs**
4. **max(updatedAt) lag** — detects sync delay independent of count accuracy

**Status thresholds and diff alerts MUST use `uniqueCount`, not `totalCount`.** The approximate `totalCount` is only useful for showing "rows processed" during a job.

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

  // Keyset watermark (µs-safe; avoid JS Date)
  watermarkCursorCol: text('watermark_cursor_col'), // e.g. 'updated_at' | 'updatedAt' | 'createdAt'
  watermarkTs: text('watermark_ts'), // ISO8601 µs UTC: '2026-01-24T09:00:00.123456Z'
  watermarkId: text('watermark_id'), // UUID text; invariant: watermarkTs+watermarkId both NULL or both set

  // Lag tracking (compare like-for-like cursor col)
  maxCursorAt: text('max_cursor_at'), // ISO8601 µs UTC; matches watermarkCursorCol

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

**CRITICAL:** Use composite covering indexes to avoid heap fetches during keyset scans.

```sql
-- PostgreSQL: Composite covering index for judgments keyset pagination
-- INCLUDE (deleted_at) allows counting active/deleted without heap access
CREATE INDEX idx_judgments_updated_id ON judgments (updated_at, id) INCLUDE (deleted_at);

-- PostgreSQL: Composite covering index for articles keyset pagination
-- Articles have no deleted_at, so just (updated_at, id) is sufficient
CREATE INDEX idx_articles_updated_id ON articles (updated_at, id);

-- PostgreSQL: Optional index for tombstone-specific queries
CREATE INDEX idx_judgments_deleted_updated ON judgments (deleted_at, updated_at)
  WHERE deleted_at IS NOT NULL;
```

**Prod note:** use `CREATE INDEX CONCURRENTLY` (can't run inside a transaction).

**Why covering indexes?**

The batch query selects `(id, updated_at, deleted_at)`. Without `INCLUDE (deleted_at)`:

- Index scan finds rows matching keyset condition
- For each row, PostgreSQL must fetch from heap to read `deleted_at`
- With 50k rows per batch, this adds 50k random heap reads

With `INCLUDE (deleted_at)`:

- All needed columns are in the index
- Pure index-only scan, no heap access
- ~10x faster for large batches

**PG note:** index-only scan needs VACUUM/visibility map; otherwise heap fetches still happen.

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

**Key fixes in this implementation:**

1. **Timezone-safe timestamps:** Use `AT TIME ZONE 'UTC'` to ensure consistent UTC output (not `to_char(..., 'Z')` which can emit local time with literal 'Z')
2. **COALESCE for nullable text:** `maxCursorAt` is nullable; use `COALESCE` to handle initial NULL state
3. **Table-specific logic:** Articles have no `deleted_at`; only judgments track active/deleted counts
4. **CTE for performance:** Use SQL CTE to compute counts + watermark in-database (don't fetch 50k rows to app)
5. **Heartbeat for stale detection:** Update `lastUpdatedAt` each batch so stale job detection works for long recounts

```ts
const BATCH_SIZE = 50_000
const STALE_JOB_MINUTES = 30

// Table-specific configuration
const TABLE_CONFIG = {
  articles: {
    table: articles,
    hasDeletedAt: false, // articles table has no deleted_at column
    updatedAtCol: 'updated_at',
  },
  judgments: {table: judgments, hasDeletedAt: true, updatedAtCol: 'updated_at'},
} as const

const countInBatches = async (tableName: 'articles' | 'judgments', db: DrizzleClient) => {
  const statsId = `pg_${tableName}`
  const config = TABLE_CONFIG[tableName]

  // PRE-REQ: seed/upsert pgChSyncStats rows for all statsId values; missing row makes FOR UPDATE + UPDATE a no-op
  // Acquire lock and set job status atomically
  // This prevents concurrent refreshes from double-counting
  const lockAcquired = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({jobStatus: pgChSyncStats.jobStatus, lastUpdatedAt: pgChSyncStats.lastUpdatedAt})
      .from(pgChSyncStats)
      .where(eq(pgChSyncStats.id, statsId))
      .for('update') // Row-level lock

    // Allow restart if job is stale (no heartbeat for STALE_JOB_MINUTES)
    const isStale =
      current?.jobStatus === 'running'
      && current.lastUpdatedAt
      && Date.now() - current.lastUpdatedAt.getTime() > STALE_JOB_MINUTES * 60 * 1000

    if (current?.jobStatus === 'running' && !isStale) {
      return false // Another job is actively running
    }

    await tx
      .update(pgChSyncStats)
      .set({
        jobStatus: 'running',
        jobStartedAt: new Date(),
        jobCurrentBatch: 0,
        jobRowsCounted: 0,
        jobError: null,
        lastUpdatedAt: new Date(), // Initial heartbeat
      })
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

      // PERFORMANCE: Use CTE to compute counts + watermark in-database
      // This avoids transferring 50k rows per batch to the application
      const batchResult = await db.execute<{
        total_count: number
        active_count: number
        deleted_count: number
        last_updated_at: string | null
        last_id: string | null
      }>(sql`
        WITH batch AS (
          SELECT
            id,
            updated_at
            ${config.hasDeletedAt ? sql`, deleted_at` : sql``}
          FROM ${sql.identifier(tableName)}
          WHERE (updated_at, id) > (
            COALESCE(${currentWatermark.ts}::timestamptz, '-infinity'::timestamptz),
            COALESCE(${currentWatermark.id}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          )
          ORDER BY updated_at ASC, id ASC
          LIMIT ${BATCH_SIZE}
        )
        SELECT
          COUNT(*)::int AS total_count,
          ${
            config.hasDeletedAt
              ? sql`COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active_count,
                 COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted_count,`
              : sql`COUNT(*)::int AS active_count,
                 0 AS deleted_count,`
          }
          (SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM batch ORDER BY updated_at DESC, id DESC LIMIT 1) AS last_updated_at,
          (SELECT id::text FROM batch ORDER BY updated_at DESC, id DESC LIMIT 1) AS last_id
        FROM batch
      `)

      const row = batchResult.rows[0]
      if (!row || row.total_count === 0) break

      const newWatermark = {ts: row.last_updated_at, id: row.last_id}

      // Atomic update: counts + watermark + progress + heartbeat in single transaction
      await db.transaction(async (tx) => {
        await tx
          .update(pgChSyncStats)
          .set({
            totalCount: sql`${pgChSyncStats.totalCount} + ${row.total_count}`,
            activeCount: sql`${pgChSyncStats.activeCount} + ${row.active_count}`,
            deletedCount: sql`${pgChSyncStats.deletedCount} + ${row.deleted_count}`,
            watermarkTs: newWatermark.ts,
            watermarkId: newWatermark.id,
            watermarkCursorCol: 'updated_at',
            maxCursorAt: sql`COALESCE(
              CASE WHEN ${pgChSyncStats.maxCursorAt} > ${newWatermark.ts}
                   THEN ${pgChSyncStats.maxCursorAt}
                   ELSE ${newWatermark.ts} END,
              ${newWatermark.ts}
            )`,
            jobCurrentBatch: batchNumber,
            jobRowsCounted: sql`${pgChSyncStats.jobRowsCounted} + ${row.total_count}`,
            lastUpdatedAt: new Date(), // Heartbeat: proves job is still alive
          })
          .where(eq(pgChSyncStats.id, statsId))
      })

      currentWatermark = newWatermark
      await Bun.sleep(100) // Rate limit
    }

    // Mark job complete
    await db
      .update(pgChSyncStats)
      .set({jobStatus: 'completed', jobCompletedAt: new Date(), lastUpdatedAt: new Date()})
      .where(eq(pgChSyncStats.id, statsId))

    return {success: true}
  } catch (error) {
    // Mark job failed
    await db
      .update(pgChSyncStats)
      .set({jobStatus: 'error', jobError: String(error), jobCompletedAt: new Date(), lastUpdatedAt: new Date()})
      .where(eq(pgChSyncStats.id, statsId))

    return {success: false, error: String(error)}
  }
}
```

### Key Properties

| Property                       | How It's Handled                                                       |
| ------------------------------ | ---------------------------------------------------------------------- |
| **Concurrent runs**            | Row-level lock via `FOR UPDATE`; second caller gets "already running"  |
| **Crash recovery**             | Watermark persisted after each batch; stale detected via heartbeat     |
| **Double-counting prevention** | Watermark advanced atomically with count increment in same transaction |
| **µs precision**               | Timestamps stored as ISO strings via `AT TIME ZONE 'UTC'` + `to_char`  |
| **Progress visibility**        | `jobCurrentBatch` and `jobRowsCounted` updated after each batch        |
| **Heartbeat**                  | `lastUpdatedAt` updated each batch; stale = no heartbeat for 30 min    |
| **Table-specific logic**       | `TABLE_CONFIG` defines which tables have `deleted_at`; articles don't  |
| **Performance**                | CTE computes counts in-database; no 50k row transfers to app           |

### Stale Job Detection (Heartbeat-Based)

A job is considered stale if `jobStatus = 'running'` but `lastUpdatedAt` (heartbeat) hasn't been updated in >30 min. This is more reliable than checking `jobStartedAt` alone, which would incorrectly mark long-running recounts (10M+ rows) as crashed.

**Why heartbeat, not start time?**

- A 10M row recount may legitimately run for 30+ minutes
- Each batch updates `lastUpdatedAt` as a heartbeat
- If heartbeat stops, the job has crashed (not just running long)

```ts
const STALE_JOB_MINUTES = 30

const isStaleJob = (stats: PgChSyncStats) =>
  stats.jobStatus === 'running'
  && stats.lastUpdatedAt
  && Date.now() - stats.lastUpdatedAt.getTime() > STALE_JOB_MINUTES * 60 * 1000

// In UI, show elapsed time since last heartbeat, not since start:
const heartbeatAge = stats.lastUpdatedAt ? Date.now() - stats.lastUpdatedAt.getTime() : null
const isHealthy = heartbeatAge !== null && heartbeatAge < 2 * 60 * 1000 // <2 min
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
        cursorCol: 'updated_at',
        maxCursorAt: '2026-01-24T10:00:00.123456Z',
      },
      ch: {
        total: 1234650,        // may be > PG due to unmerged duplicates
        active: 1234500,
        deleted: 150,
        uniqueCount: 1234500,  // from uniqExact (on-demand)
        cursorCol: 'updated_at',
        maxCursorAt: '2026-01-24T09:30:00.456789Z',
        dedupDrift: 150,       // total - uniqueCount
      },
      // Comparison
      diff: {
        absolute: -83,         // negative = CH ahead (unmerged dups)
        percentage: -0.007,
        direction: 'ch_ahead', // 'pg_ahead' | 'ch_ahead' | 'synced'
      },
      lag: {
        seconds: 1800,         // only when both sides use same cursorCol; else null + warning
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

**CRITICAL:** When comparing CH data to PG, use `FINAL` or `argMax` to get the latest version of each row. Without this, you'll get false mismatches during ReplacingMergeTree merge lag (unmerged old versions will compare against PG's current version).

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

**Implementation notes:**

```ts
// Don't do ORDER BY random() on PG/CH at 10M+ rows.
// Pick ids via recent window or TABLESAMPLE/hashed sampling, then WHERE id IN (...)

// Option 1: Use FINAL modifier (simpler, may be slower for full table)
const chRows = await clickhouseClient.query({
  query: `SELECT id, articleTitle, ... FROM forska.judgments FINAL WHERE id IN ({ids:Array(String)})`,
  query_params: {ids: sampleIds},
})

// Option 2: Use argMax for specific columns (more control, works per-column)
const chRows = await clickhouseClient.query({
  query: `
    SELECT
      id,
      argMax(articleTitle, updatedAt) as articleTitle,
      argMax(deletedAt, updatedAt) as deletedAt
    FROM forska.judgments
    WHERE id IN ({ids:Array(String)})
    GROUP BY id
  `,
  query_params: {ids: sampleIds},
})

// NOTE: argMax requires updatedAt column - gate behind PG_CH_HEALTH.md Phase-1 completion
```

### `POST /api/admin/partition-coverage-check`

Detect missing older partitions not caught by lag alone. A synced `maxCursorAt` doesn't guarantee older data exists.

```ts
// Request body
{
  table: 'articles' | 'judgments',
  months?: number, // default: 12 (check last 12 months)
}

// Response
{
  months: [
    { month: '2025-12', pg: 45000, ch: 45000, diff: 0, status: 'synced' },
    { month: '2025-11', pg: 42000, ch: 42000, diff: 0, status: 'synced' },
    { month: '2025-10', pg: 38000, ch: 0, diff: 38000, status: 'missing' }, // CH partition missing!
    // ...
  ],
  summary: {
    totalPg: 500000,
    totalCh: 462000,
    missingMonths: ['2025-10'],
    status: 'partition_gap',
  },
}
```

**Implementation:**

```ts
// PostgreSQL: Count per month
const pgCounts = await db.execute(sql`
  SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') as month, COUNT(*)::int as count
  FROM judgments
  WHERE created_at >= NOW() - make_interval(months => ${months})
  GROUP BY 1 ORDER BY 1 DESC
`)

// ClickHouse: Count per month (uses partition column efficiently)
const chCounts = await clickhouseClient.query({
  query: `
    SELECT formatDateTime(toTimeZone(createdAt, 'UTC'), '%Y-%m') as month, count() as count
    FROM forska.judgments
    WHERE createdAt >= now64(6, 'UTC') - INTERVAL {months:Int32} MONTH
    GROUP BY month ORDER BY month DESC
  `,
  query_params: {months},
})
```

---

## Counting Logic

### ClickHouse Articles (snake_case columns)

**IMPORTANT:** The `forska.articles` table uses snake_case column names (`updated_at`, `created_at`, `import_route`), not camelCase.

```ts
// Default CH counts: cheap `count()`, avoid `uniqExact()` unless on-demand
const result = await clickhouseClient.query({
  query: `
    SELECT
      count(*) as totalCount,
      uniqCombined(id) as uniqueCountApprox,
      max(updated_at) as maxCursorAt
    FROM forska.articles
  `,
})
```

### ClickHouse Judgments (camelCase columns)

**CRITICAL DEPENDENCY:** The queries below using `updatedAt` require PG_CH_HEALTH.md Phase-1 to be completed first. The current CH schema (`clickhouse-setup.sql`) does NOT have an `updatedAt` column — it only has `createdAt`.

```ts
// Runtime feature flag: does CH have updatedAt?
const CH_HAS_UPDATED_AT = await hasClickhouseColumn('forska', 'judgments', 'updatedAt')

// Pre-Phase-1: Use createdAt (limited - misses updates)
// Post-Phase-1: Use updatedAt (correct - captures updates)
const cursorCol = CH_HAS_UPDATED_AT ? 'updatedAt' : 'createdAt'

// Basic count for CH judgments
const result = await clickhouseClient.query({
  query: `
    SELECT
      count(*) as totalCount,
      countIf(deletedAt IS NULL) as activeCount,
      countIf(deletedAt IS NOT NULL) as deletedCount,
      max(${cursorCol}) as maxCursorAt
    FROM forska.judgments
  `,
})

// Approximate unique count (fast, default) - use uniq() or uniqCombined()
// uniq() has ~2% error, uniqCombined() has ~1% error
// MUCH faster than uniqExact() on large tables
const approxUniqueResult = await clickhouseClient.query({
  query: `
    SELECT uniqCombined(id) as uniqueCountApprox
    FROM forska.judgments
  `,
})

// Accurate unique count (expensive - on-demand only)
// Scope to recent partitions when possible for performance
const exactUniqueResult = await clickhouseClient.query({
  query: `
    SELECT uniqExact(id) as uniqueCountExact
    FROM forska.judgments
    -- Partition-scoped version (much faster):
    -- WHERE createdAt >= now() - INTERVAL 90 DAY
  `,
})
```

**Column existence helper:**

```ts
const hasClickhouseColumn = async (db: string, table: string, col: string) => {
  const result = await clickhouseClient.query({
    query: `
      SELECT count() AS cnt
      FROM system.columns
      WHERE database = {db:String} AND table = {table:String} AND name = {col:String}
    `,
    query_params: {db, table, col},
    format: 'JSONEachRow',
  })
  const row = await result.json<{cnt: string}>()
  return Number(Array.isArray(row) ? row[0]?.cnt : row?.cnt) > 0
}
```

**Unique count strategy:**

| Context                | Function         | Error | Use When                               |
| ---------------------- | ---------------- | ----- | -------------------------------------- |
| Dashboard display      | `uniqCombined()` | ~1%   | Always (fast, good enough)             |
| Drift alerts           | `uniqCombined()` | ~1%   | Threshold >= 2% so error doesn't matter |
| Export/audit           | `uniqExact()`    | 0%    | On-demand button, warn about latency   |
| Partition-scoped check | `uniqExact()`    | 0%    | Scope to recent 90 days for speed      |

**OPTIMIZE TABLE usage:**

```ts
// NEVER run OPTIMIZE ... FINAL on full table in production
// Instead, scope to specific partition if needed:
await clickhouseClient.command({query: `OPTIMIZE TABLE forska.judgments PARTITION '202601' FINAL`})

// Or let background merges happen naturally (usually sufficient)
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
- Track lag from `maxCursorAt` only when both sides use same cursorCol (else "lag unavailable")

---

## Status Thresholds

**CRITICAL:** Use `uniqueCount` (not `totalCount`) for diff calculations and threshold alerts. `totalCount` inflates on updates and is unsuitable for accurate comparisons.
If CH `uniqueCount` comes from `uniqCombined()`, don't use sub-1% thresholds (est error ~1%).

| Condition                                                 | Status        | Badge Color | Meaning               |
| --------------------------------------------------------- | ------------- | ----------- | --------------------- |
| lag < 1h AND \|uniqueDiff\| < 2% AND dedupDrift < 100     | Synced        | Green       | Healthy (approx)      |
| lag 1-6h OR \|uniqueDiff\| 2-5%                           | Behind        | Yellow      | Minor lag             |
| lag > 6h OR \|uniqueDiff\| > 5%                           | Critical      | Red         | Needs attention       |
| CH uniqueCount > PG uniqueCount + 1000 (shouldn't happen) | Data Error    | Red         | Investigate           |
| dedupDrift > 1000                                         | Merge Pending | Orange      | Background merge slow |
| CH unreachable                                            | Unreachable   | Gray        | Connection error      |
| PG uniqueCount = 0                                        | Empty         | Gray        | No data               |
| partitionCoverage has gaps                                | Partition Gap | Orange      | Run partition check   |

**Display both absolute and percentage (using uniqueCount):**

```
Unique diff: 8,901 rows (0.16%) — CH behind
Unique diff: 0 rows (0.00%) — Synced
Dedup drift: 150 rows — merge pending (count(*) - uniqCombined)
```

**Why uniqueCount, not totalCount?**

- `totalCount` inflates each time a row is updated (re-counted via keyset)
- `uniqueCount` from full recount or `uniqCombined()` is stable
- Comparing inflated `totalCount` values would trigger false alerts

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

### Phase 0: Prerequisites

1. [ ] **BLOCKING:** Complete PG_CH_HEALTH.md Phase-1 (add `updatedAt` to CH judgments)
   - Until complete: judgments update-lag unavailable; only insert-lag via `createdAt`
   - After migration: runtime detect column; force full recount/baseline when cursor col changes

### Phase 1: Database & API

2. [ ] Add `pgChSyncStats` table to Drizzle schema (with job\* columns + heartbeat)
3. [ ] Generate and run migration
4. [ ] Add composite covering indexes:
   - `judgments (updated_at, id) INCLUDE (deleted_at)`
   - `articles (updated_at, id)`
5. [ ] Create `GET /api/admin/sync-stats` endpoint
6. [ ] Create `POST /api/admin/refresh-sync-stats` with DB-persisted job state
7. [ ] Create `GET /api/admin/refresh-sync-stats-progress` (reads from DB)
8. [ ] Implement batched counting with:
   - CTE-based counting (no row transfers)
   - Table-specific logic (`TABLE_CONFIG`)
   - Heartbeat updates each batch
   - `AT TIME ZONE 'UTC'` for timestamp formatting
   - `COALESCE` for nullable `maxCursorAt`
9. [ ] Seed/upsert 4 `pgChSyncStats` rows (else locks no-op)
10. [ ] Implement lag tracking (only when cursorCol matches)
11. [ ] Handle CH articles snake_case vs judgments camelCase
12. [ ] Use `uniqCombined()` for default unique counts, `uniqExact()` on-demand

### Phase 2: Admin UI

13. [ ] Create `/admin/sync-stats` page
14. [ ] Add cards showing total/unique/deleted breakdown
15. [ ] Show both absolute diff AND percentage **using uniqueCount**
16. [ ] Show "CH ahead" vs "CH behind" direction
17. [ ] Show lag time and dedup drift
18. [ ] Add job status indicators with batch progress + heartbeat age
19. [ ] Add refresh button (disabled if job running)
20. [ ] Add "Full Recount" option
21. [ ] Show "approximate" labels on all counts

### Phase 3: Verification & Integrity Checks

22. [ ] Implement `POST /api/admin/sample-verify` endpoint with `FINAL`/`argMax`
23. [ ] Implement `POST /api/admin/partition-coverage-check` endpoint
24. [ ] Add sample verify UI with results display
25. [ ] Add partition coverage UI showing per-month counts
26. [ ] Add stale job detection (>30min since last heartbeat = crashed)
27. [ ] Add logging for debugging

### Phase 4: Polish & Hardening

28. [ ] Add backfill detection (rows with old `updatedAt` trigger warning)
29. [ ] Consider scheduled refresh (cron) if needed
30. [ ] Document when to run full recount vs incremental

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
3. **Count goes down (deletes/updates)**: Expected — `totalCount` only grows; use `uniqueCount` for accuracy
4. **CH count > PG count**: Unmerged duplicates; show as "merge pending", not error
5. **Concurrent refresh attempts**: Row-level lock returns "already running"
6. **Crashed job**: Detect via stale heartbeat (`lastUpdatedAt` > 30min old); allow manual restart
7. **µs precision**: Store as ISO string with `AT TIME ZONE 'UTC'` + `to_char(..., 'US')`, never JS Date
8. **Multi-instance deployment**: Job state in DB, not memory; all instances see same progress
9. **Retroactive backfills**: Rows with old `updatedAt` skip watermark; schedule full recount after backfills
10. **Articles vs judgments schema**: Articles have no `deleted_at`; use `TABLE_CONFIG` for table-specific logic
11. **CH judgments pre-Phase-1**: No `updatedAt` column; fall back to `createdAt` (misses updates)
12. **Long-running recount**: Heartbeat keeps job alive; don't misclassify as crashed based on start time alone

---

## Future Enhancements

- Scheduled background refresh (every 15 min)
- Historical tracking (count over time chart)
- Per-project breakdown
- Alert notifications when diff exceeds threshold
- Automatic OPTIMIZE TABLE trigger when dedup drift exceeds threshold
- Job queue (pg-boss) for more robust background processing
