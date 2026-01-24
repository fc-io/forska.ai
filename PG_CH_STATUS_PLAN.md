# PostgreSQL / ClickHouse Sync Admin UI

## Overview

Admin page to monitor data consistency between PostgreSQL (source of truth) and ClickHouse (analytics replica). Shows row counts for articles and judgments in both databases, with discrepancy detection.

## Architecture

### Incremental Counting with Watermarks

Instead of running expensive `COUNT(*)` queries on every page load, we:

1. **Store cached counts** in a PostgreSQL table (`syncStats`)
2. **Track watermarks** (the `createdAt` timestamp of the last row we counted)
3. **Increment counts** by only counting rows newer than the watermark
4. **Refresh on-demand** via admin UI button with progress tracking

### Why Watermarks?

| Approach       | First Run       | Subsequent Runs      | Notes                        |
| -------------- | --------------- | -------------------- | ---------------------------- |
| Full COUNT(\*) | Slow (scan all) | Slow (scan all)      | Simple but expensive         |
| Watermark      | Slow (scan all) | Fast (scan new only) | Efficient for growing tables |

A watermark is simply the `createdAt` timestamp of the newest row we've counted. On the next run, we only count rows WHERE `createdAt > watermark`.

---

## Database Schema

### New Table: `syncStats`

```ts
// src/db/schema.ts

export const syncStats = pgTable('sync_stats', {
  id: text('id').primaryKey(), // e.g., 'pg_articles', 'ch_articles', 'pg_judgments', 'ch_judgments'
  count: bigint('count', {mode: 'number'}).notNull().default(0),
  watermark: timestamp('watermark', {withTimezone: true, mode: 'date'}), // last createdAt counted
  lastUpdatedAt: timestamp('last_updated_at', {withTimezone: true, mode: 'date'}).notNull(),
  lastFullCountAt: timestamp('last_full_count_at', {withTimezone: true, mode: 'date'}), // for reference
})
```

**Rows:**
| id | count | watermark | lastUpdatedAt |
|----|-------|-----------|---------------|
| pg_articles | 1,234,567 | 2026-01-24T09:00:00Z | 2026-01-24T10:00:00Z |
| ch_articles | 1,234,500 | 2026-01-24T08:30:00Z | 2026-01-24T10:00:00Z |
| pg_judgments | 5,678,901 | 2026-01-24T09:00:00Z | 2026-01-24T10:00:00Z |
| ch_judgments | 5,670,000 | 2026-01-24T08:30:00Z | 2026-01-24T10:00:00Z |

---

## API Endpoints

### `GET /api/admin/sync-stats`

Returns current cached counts from `syncStats` table.

```ts
// Response
{
  stats: [
    { id: 'pg_articles', count: 1234567, watermark: '2026-01-24T09:00:00Z', lastUpdatedAt: '...' },
    { id: 'ch_articles', count: 1234500, watermark: '2026-01-24T08:30:00Z', lastUpdatedAt: '...' },
    { id: 'pg_judgments', count: 5678901, watermark: '...', lastUpdatedAt: '...' },
    { id: 'ch_judgments', count: 5670000, watermark: '...', lastUpdatedAt: '...' },
  ],
  discrepancies: {
    articles: { pg: 1234567, ch: 1234500, diff: 67, status: 'behind' },
    judgments: { pg: 5678901, ch: 5670000, diff: 8901, status: 'critical' },
  }
}
```

### `POST /api/admin/refresh-sync-stats`

Triggers incremental count update. Returns immediately, runs async.

```ts
// Request body (optional)
{
  tables?: ('pg_articles' | 'ch_articles' | 'pg_judgments' | 'ch_judgments')[], // default: all
  fullRecount?: boolean // default: false — if true, ignores watermark and recounts from scratch
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

---

## Counting Logic

### PostgreSQL Counts

```ts
// Incremental count for articles
const incrementalCount = await db.select({count: count()}).from(article).where(gt(article.createdAt, currentWatermark))

const newWatermark = await db.select({maxCreatedAt: max(article.createdAt)}).from(article)

// Update syncStats
await db
  .update(syncStats)
  .set({count: existingCount + incrementalCount, watermark: newWatermark, lastUpdatedAt: new Date()})
  .where(eq(syncStats.id, 'pg_articles'))
```

### ClickHouse Counts

```ts
// Using existing clickhouseClient
const result = await clickhouseClient.query({
  query: `
    SELECT count(*) as count, max(createdAt) as maxCreatedAt
    FROM forska.articles
    WHERE createdAt > {watermark:DateTime64(6, 'UTC')}
  `,
  query_params: {watermark: currentWatermark},
})
```

### Handling Deletions

For judgments (which support soft delete via `deletedAt`):

- PostgreSQL: Count WHERE `deletedAt IS NULL`
- ClickHouse: Uses ReplacingMergeTree, so deletions are handled via tombstones

For a full accurate count of "active" rows, we periodically do a full recount (e.g., weekly) and store `lastFullCountAt`.

---

## UI Components

### Admin Page: `/admin/sync-stats`

```
+----------------------------------------------------------+
|  Database Sync Status                                     |
+----------------------------------------------------------+
|                                                          |
|  +----------------------+  +----------------------+       |
|  | ARTICLES             |  | JUDGMENTS            |       |
|  |                      |  |                      |       |
|  | PostgreSQL: 1,234,567|  | PostgreSQL: 5,678,901|       |
|  | ClickHouse: 1,234,500|  | ClickHouse: 5,670,000|       |
|  |                      |  |                      |       |
|  | Diff: 67 behind      |  | Diff: 8,901 behind   |       |
|  | Status: [OK]         |  | Status: [CRITICAL]   |       |
|  +----------------------+  +----------------------+       |
|                                                          |
|  Last updated: 2 minutes ago                             |
|                                                          |
|  [Refresh Counts]  [Full Recount]                        |
|                                                          |
|  Progress: Counting pg_judgments... (3/4)                |
|  ████████████░░░░ 75%                                    |
|                                                          |
+----------------------------------------------------------+
```

### Status Thresholds

| Diff %    | Status   | Badge Color |
| --------- | -------- | ----------- |
| < 0.1%    | Synced   | Green       |
| 0.1% - 1% | Behind   | Yellow      |
| > 1%      | Critical | Red         |

---

## Implementation Tasks

### Phase 1: Database & API

1. [ ] Add `syncStats` table to Drizzle schema
2. [ ] Generate and run migration
3. [ ] Create `GET /api/admin/sync-stats` endpoint
4. [ ] Create `POST /api/admin/refresh-sync-stats` endpoint with async runner
5. [ ] Create `GET /api/admin/refresh-sync-stats-progress` endpoint
6. [ ] Implement incremental counting logic for all 4 sources

### Phase 2: Admin UI

7. [ ] Create `/admin/sync-stats` page
8. [ ] Add cards for articles and judgments comparison
9. [ ] Add status badges with color coding
10. [ ] Add refresh button with progress polling
11. [ ] Add "Full Recount" option for periodic accuracy reset

### Phase 3: Polish

12. [ ] Add error handling and retry logic
13. [ ] Add logging for debugging
14. [ ] Consider adding scheduled refresh (cron) if needed

---

## File Structure

```
src/
├── db/
│   └── schema.ts                    # Add syncStats table
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

---

## Future Enhancements

- Scheduled background refresh (every 15 min)
- Historical tracking (count over time chart)
- Per-project breakdown
- Alert notifications when diff exceeds threshold
