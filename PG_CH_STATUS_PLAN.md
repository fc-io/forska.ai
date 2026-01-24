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

---

## Database Schema

### New Table: `pgChSyncStats`

```ts
// src/db/schema.ts

export const pgChSyncStats = pgTable('pg_ch_sync_stats', {
  id: text('id').primaryKey(), // e.g., 'pg_articles', 'ch_articles', 'pg_judgments', 'ch_judgments'

  // Counts
  totalCount: bigint('total_count', {mode: 'number'}).notNull().default(0),
  activeCount: bigint('active_count', {mode: 'number'}).notNull().default(0), // excludes soft-deleted
  deletedCount: bigint('deleted_count', {mode: 'number'}).notNull().default(0), // soft-deleted only

  // Keyset watermark (stored as strings to preserve full precision)
  watermarkTs: text('watermark_ts'), // ISO8601 with microseconds: '2026-01-24T09:00:00.123456Z'
  watermarkId: text('watermark_id'), // UUID of last row counted

  // Lag tracking
  maxCreatedAt: text('max_created_at'), // latest createdAt seen
  maxUpdatedAt: text('max_updated_at'), // latest updatedAt seen

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

**Note:** ClickHouse queries on `createdAt`/`updatedAt` will scan active partitions unless those columns are in ORDER BY. Keep expensive checks (FINAL, uniqExact) scoped to recent partitions or on-demand only.

---

## API Endpoints

### `GET /api/admin/sync-stats`

Returns current cached counts and health metrics from `pgChSyncStats` table.

```ts
// Response
{
  stats: {
    articles: {
      pg: { total: 1234567, active: 1234567, deleted: 0, maxUpdatedAt: '...', lastUpdatedAt: '...' },
      ch: { total: 1234500, active: 1234500, deleted: 0, maxUpdatedAt: '...', lastUpdatedAt: '...' },
      diff: { total: 67, active: 67, deleted: 0 },
      lag: { updatedAtSeconds: 1800 }, // CH is 30min behind PG
      status: 'behind',
    },
    judgments: {
      pg: { total: 5678901, active: 5600000, deleted: 78901, maxUpdatedAt: '...', lastUpdatedAt: '...' },
      ch: { total: 5670000, active: 5592000, deleted: 78000, maxUpdatedAt: '...', lastUpdatedAt: '...' },
      diff: { total: 8901, active: 8000, deleted: 901 },
      lag: { updatedAtSeconds: 3600 },
      status: 'critical',
      dedupDrift: 150, // CH count(*) - uniqExact(id), indicates unmerged duplicates
    },
  },
  lastRefreshedAt: '2026-01-24T10:00:00Z',
}
```

### `POST /api/admin/refresh-sync-stats`

Triggers incremental count update. Returns immediately, runs async.

```ts
// Request body (optional)
{
  tables?: ('pg_articles' | 'ch_articles' | 'pg_judgments' | 'ch_judgments')[],
  fullRecount?: boolean, // default: false — if true, ignores watermark and recounts from scratch
  includeDedupCheck?: boolean, // default: false — if true, runs expensive uniqExact check on CH
}

// Response
{ started: true, message: 'Sync stats refresh started' }
```

### `GET /api/admin/refresh-sync-stats-progress`

Poll for progress during refresh.

```ts
// Response
{
  status: 'idle' | 'running' | 'completed' | 'error',
  currentTable: 'pg_articles' | null,
  tablesCompleted: ['pg_articles', 'ch_articles'],
  tablesRemaining: ['pg_judgments', 'ch_judgments'],
  startedAt: '...',
  completedAt: '...' | null,
  error: '...' | null,
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
  missingInCh: ['id1', 'id2'], // IDs in PG but not in CH
  missingInPg: [], // IDs in CH but not in PG (shouldn't happen)
  fieldMismatches: [
    { id: 'id3', field: 'articleTitle', pg: 'Title A', ch: 'Title B' }
  ],
}
```

---

## Counting Logic

### PostgreSQL Counts (Single Atomic Query)

```ts
// CRITICAL: Count and max in ONE query to avoid race conditions
const result = await db
  .select({
    totalCount: count(),
    activeCount: count(sql`CASE WHEN ${article.deletedAt} IS NULL THEN 1 END`),
    deletedCount: count(sql`CASE WHEN ${article.deletedAt} IS NOT NULL THEN 1 END`),
    maxUpdatedAt: max(article.updatedAt),
    maxCreatedAt: max(article.createdAt),
    // For keyset: get the row with max (updatedAt, id)
  })
  .from(article)
  .where(
    or(
      gt(article.updatedAt, currentWatermarkTs),
      and(eq(article.updatedAt, currentWatermarkTs), gt(article.id, currentWatermarkId)),
    ),
  )

// Get the new watermark (last row in keyset order)
const lastRow = await db
  .select({updatedAt: article.updatedAt, id: article.id})
  .from(article)
  .orderBy(desc(article.updatedAt), desc(article.id))
  .limit(1)

// Update pgChSyncStats atomically
await db
  .update(pgChSyncStats)
  .set({
    totalCount: sql`${pgChSyncStats.totalCount} + ${result.totalCount}`,
    activeCount: sql`${pgChSyncStats.activeCount} + ${result.activeCount}`,
    deletedCount: sql`${pgChSyncStats.deletedCount} + ${result.deletedCount}`,
    watermarkTs: lastRow.updatedAt.toISOString(),
    watermarkId: lastRow.id,
    maxUpdatedAt: result.maxUpdatedAt?.toISOString(),
    maxCreatedAt: result.maxCreatedAt?.toISOString(),
    lastUpdatedAt: new Date(),
  })
  .where(eq(pgChSyncStats.id, 'pg_articles'))
```

### ClickHouse Counts

```ts
// Basic count (fast, but may include unmerged duplicates)
const basicResult = await clickhouseClient.query({
  query: `
    SELECT 
      count(*) as totalCount,
      countIf(deletedAt IS NULL) as activeCount,
      countIf(deletedAt IS NOT NULL) as deletedCount,
      max(updatedAt) as maxUpdatedAt,
      max(createdAt) as maxCreatedAt
    FROM forska.judgments
    WHERE (updatedAt, id) > ({watermarkTs:DateTime64(6, 'UTC')}, {watermarkId:String})
  `,
  query_params: {watermarkTs: currentWatermarkTs, watermarkId: currentWatermarkId},
})

// Dedup drift check (expensive - use sparingly, scope to recent partitions)
const dedupResult = await clickhouseClient.query({
  query: `
    SELECT 
      count(*) as rawCount,
      uniqExact(id) as uniqueCount
    FROM forska.judgments
    WHERE createdAt >= now() - INTERVAL 7 DAY
  `,
})
// dedupDrift = rawCount - uniqueCount
```

### Handling Deletions & ReplacingMergeTree

ClickHouse's ReplacingMergeTree is **eventually consistent** — tombstones (rows with `deletedAt` set) may not be merged immediately. This causes:

1. **Overcounting**: `count(*)` includes unmerged duplicates
2. **False alerts**: `countIf(deletedAt IS NULL)` may be wrong until merge

**Mitigations:**

- Track `dedupDrift` = `count(*) - uniqExact(id)` on recent partitions
- Use `FINAL` modifier sparingly (expensive) for accurate counts when needed
- Show "approximate" label on CH counts in UI
- Alert only when drift exceeds threshold AND persists across multiple checks

---

## Status Thresholds

| Condition                | Status      | Badge Color |
| ------------------------ | ----------- | ----------- |
| Diff < 0.1% AND lag < 1h | Synced      | Green       |
| Diff 0.1-1% OR lag 1-6h  | Behind      | Yellow      |
| Diff > 1% OR lag > 6h    | Critical    | Red         |
| CH unreachable           | Unreachable | Gray        |
| Zero rows in PG          | Empty       | Gray        |

**Note:** Percentage is calculated as `diff / max(pgCount, 1)` to handle zero-row edge case.

---

## UI Components

### Admin Page: `/admin/sync-stats`

```
+------------------------------------------------------------------+
|  Database Sync Status                                             |
+------------------------------------------------------------------+
|                                                                  |
|  +---------------------------+  +---------------------------+     |
|  | ARTICLES                  |  | JUDGMENTS                 |     |
|  |                           |  |                           |     |
|  | PostgreSQL                |  | PostgreSQL                |     |
|  |   Total:  1,234,567       |  |   Total:  5,678,901       |     |
|  |   Active: 1,234,567       |  |   Active: 5,600,000       |     |
|  |   Deleted: 0              |  |   Deleted: 78,901         |     |
|  |                           |  |                           |     |
|  | ClickHouse (approx)       |  | ClickHouse (approx)       |     |
|  |   Total:  1,234,500       |  |   Total:  5,670,000       |     |
|  |   Active: 1,234,500       |  |   Active: 5,592,000       |     |
|  |   Deleted: 0              |  |   Deleted: 78,000         |     |
|  |                           |  |   Dedup drift: 150        |     |
|  | Diff: 67 behind           |  | Diff: 8,901 behind        |     |
|  | Lag: 30 min               |  | Lag: 1 hour               |     |
|  | Status: [BEHIND]          |  | Status: [CRITICAL]        |     |
|  +---------------------------+  +---------------------------+     |
|                                                                  |
|  Last updated: 2 minutes ago                                     |
|                                                                  |
|  [Refresh Counts]  [Full Recount]  [Sample Verify]               |
|                                                                  |
|  Progress: Counting pg_judgments... (3/4)                        |
|  ████████████░░░░ 75%                                            |
|                                                                  |
+------------------------------------------------------------------+
```

---

## Implementation Tasks

### Phase 1: Database & API

1. [ ] Add `pgChSyncStats` table to Drizzle schema
2. [ ] Generate and run migration
3. [ ] Add indexes for `(updatedAt, id)` on articles and judgments
4. [ ] Create `GET /api/admin/sync-stats` endpoint
5. [ ] Create `POST /api/admin/refresh-sync-stats` endpoint with async runner
6. [ ] Create `GET /api/admin/refresh-sync-stats-progress` endpoint
7. [ ] Implement keyset-based incremental counting for all 4 sources
8. [ ] Implement lag tracking (max updatedAt comparison)

### Phase 2: Admin UI

9. [ ] Create `/admin/sync-stats` page
10. [ ] Add cards for articles and judgments comparison
11. [ ] Show total/active/deleted breakdown
12. [ ] Show lag time and dedup drift
13. [ ] Add status badges with color coding (consider both diff AND lag)
14. [ ] Add refresh button with progress polling
15. [ ] Add "Full Recount" option for periodic accuracy reset

### Phase 3: Verification & Polish

16. [ ] Implement `POST /api/admin/sample-verify` endpoint
17. [ ] Add sample verify UI with results display
18. [ ] Add error handling and retry logic
19. [ ] Add logging for debugging
20. [ ] Consider adding scheduled refresh (cron) if needed

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

1. **First run (no watermark)**: Do a full count, set initial watermark
2. **ClickHouse unreachable**: Show "Unreachable" status, use cached count
3. **Count goes down**: Can happen with deletions — full recount will correct
4. **Large backlog**: Progress UI shows estimated time remaining
5. **Zero rows**: Show "Empty" status, avoid division by zero in percentage calc
6. **Microsecond precision**: Store watermark timestamps as ISO strings with full precision
7. **High dedup drift**: Warn user that CH counts are approximate until merge completes
8. **Out-of-order inserts**: Keyset watermark handles this correctly

---

## Future Enhancements

- Scheduled background refresh (every 15 min)
- Historical tracking (count over time chart)
- Per-project breakdown
- Alert notifications when diff exceeds threshold
- Automatic OPTIMIZE TABLE trigger when dedup drift exceeds threshold
