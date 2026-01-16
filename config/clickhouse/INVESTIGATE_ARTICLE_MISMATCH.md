# Articles Table Mismatch Investigation Plan

## ✅ RESOLVED (2026-01-16)

**Final Status:**
- PostgreSQL: 10,526,004 articles
- ClickHouse: 10,526,004 articles (forska.articles)
- **100% match achieved**

### Root Cause
MaterializedPostgreSQL engine has a bug with large table initial snapshots. Multiple attempts produced incomplete syncs:
- 1st attempt: 10,341,151 rows (98.2%)
- 2nd attempt: 6,737,127 rows (64%)

### Solution
Created a standard MergeTree table (`forska.articles`) and synced via batch INSERT from `postgresql()` function:
1. Created `forska.articles` with ReplacingMergeTree(updated_at)
2. Full sync via: `INSERT INTO forska.articles SELECT ... FROM postgresql('db:5432', ...)`
3. Sync completed in ~3 minutes
4. Incremental sync script: `scripts/syncArticlesToClickHouse.ts`

### Changes Made
- Created `forska.articles` MergeTree table (replacing unreliable `pg.articles`)
- Updated `forska_helpers.scoped_articles` view to use `forska.articles`
- Added `scripts/syncArticlesToClickHouse.ts` for incremental sync
- Note: Excluded `article_authors`, `original_data`, `full_text_assets` columns (array/JSON with potential null bytes)

### Next Steps
- [ ] Set up cron job for periodic incremental sync (e.g., every 5 minutes)
- [ ] Consider cleaning up incomplete `pg` database
- [ ] Monitor memory usage on `scoped_articles` view queries

---

## Original Problem Statement

**Original Status:**
- PostgreSQL: 10,526,004 articles
- ClickHouse: 10,341,151 articles
- **Missing: 184,853 articles (1.8%)**

This discrepancy is NOT acceptable. We need to identify the root cause and ensure 100% sync.

## Investigation Steps

### 1. Identify Which Articles Are Missing

**Goal:** Get list of article IDs present in PG but not in CH

```sql
-- In PostgreSQL: Export article IDs
COPY (SELECT id FROM articles ORDER BY id) TO '/tmp/pg_article_ids.csv';

-- In ClickHouse: Export article IDs
SELECT id FROM pg.articles ORDER BY id INTO OUTFILE '/tmp/ch_article_ids.csv';

-- Compare: Find missing IDs
# Use diff, comm, or join commands to find differences
```

**Alternative approach (if file export not feasible):**
```sql
-- Get sample of article IDs from both systems
-- PostgreSQL
SELECT id FROM articles ORDER BY created_at LIMIT 1000;
SELECT id FROM articles ORDER BY created_at DESC LIMIT 1000;

-- ClickHouse
SELECT id FROM pg.articles ORDER BY created_at LIMIT 1000;
SELECT id FROM pg.articles ORDER BY created_at DESC LIMIT 1000;

-- Look for patterns: are missing articles old? new? random?
```

### 2. Check Articles Created/Updated During Initial Sync

**Hypothesis:** Articles created/updated during snapshot may have been missed

```sql
-- PostgreSQL: Check articles created during sync window (2026-01-16 07:00 - 09:00 CET)
SELECT COUNT(*), MIN(created_at), MAX(created_at)
FROM articles
WHERE created_at >= '2026-01-16 07:00:00'
  AND created_at <= '2026-01-16 09:00:00';

-- Check updated_at in same window
SELECT COUNT(*), MIN(updated_at), MAX(updated_at)
FROM articles
WHERE updated_at >= '2026-01-16 07:00:00'
  AND updated_at <= '2026-01-16 09:00:00';
```

### 3. Check for Deleted Articles

**Hypothesis:** Articles that existed during snapshot but were later deleted wouldn't show in PG count

```sql
-- PostgreSQL: Check if deleted_at column exists
\d articles

-- If soft-delete column exists:
SELECT COUNT(*) FROM articles WHERE deleted_at IS NOT NULL;

-- ClickHouse: Check for _sign column (ReplacingMergeTree soft deletes)
SELECT COUNT(*) FROM pg.articles WHERE _sign = -1;
```

### 4. Check ReplacingMergeTree Behavior

**Issue:** ClickHouse ReplacingMergeTree may not have merged duplicates yet

```sql
-- ClickHouse: Force table optimization to merge duplicates
OPTIMIZE TABLE pg.articles FINAL;

-- Then recount
SELECT COUNT(*) FROM pg.articles;
SELECT COUNT(DISTINCT id) FROM pg.articles;

-- Check for duplicate IDs before optimization
SELECT id, COUNT(*) as cnt
FROM pg.articles
GROUP BY id
HAVING cnt > 1
LIMIT 100;
```

### 5. Check Replication Slot Position

**Goal:** Verify if initial snapshot completed successfully

```sql
-- PostgreSQL: Check replication slot status
SELECT
  slot_name,
  active,
  restart_lsn,
  confirmed_flush_lsn,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as lag
FROM pg_replication_slots
WHERE slot_name = 'postgres';

-- Check if slot was created during initial snapshot
SELECT slot_name, xmin, catalog_xmin FROM pg_replication_slots WHERE slot_name = 'postgres';
```

### 6. Check ClickHouse Sync Logs

**Goal:** Look for errors or warnings during initial sync

```bash
# Check ClickHouse logs for MaterializedPostgreSQL errors
docker exec forska-stack-clickhouse-1 grep -i "materialized\|postgresql\|error\|warn" \
  /var/log/clickhouse-server/clickhouse-server.log | grep "2026-01-16 0[7-9]:"

# Check error log for exceptions during sync
docker exec forska-stack-clickhouse-1 cat /var/log/clickhouse-server/clickhouse-server.err.log \
  | grep "2026-01-16" | grep -i "article"
```

### 7. Check Table Statistics

```sql
-- PostgreSQL: Detailed table stats
SELECT
  schemaname,
  relname,
  n_live_tup as live_rows,
  n_dead_tup as dead_rows,
  last_vacuum,
  last_autovacuum,
  last_analyze
FROM pg_stat_user_tables
WHERE relname = 'articles';

-- ClickHouse: Table parts and rows
SELECT
  partition,
  name,
  rows,
  modification_time
FROM system.parts
WHERE database = 'pg' AND table = 'articles'
ORDER BY modification_time DESC
LIMIT 20;
```

## Potential Root Causes

### A. Snapshot Timing Issue
- Articles created/updated during initial snapshot may have been skipped
- Replication slot created after snapshot started
- **Fix:** Drop and recreate pg database to retrigger full snapshot

### B. ReplacingMergeTree Not Merged
- Duplicate rows exist but `COUNT(*)` counts them all
- `OPTIMIZE TABLE FINAL` needed to merge
- **Fix:** Run OPTIMIZE TABLE pg.articles FINAL

### C. Transaction Isolation
- Long-running transactions during snapshot
- Articles in uncommitted state during snapshot
- **Fix:** May self-resolve as replication catches up

### D. MaterializedPostgreSQL Bug
- Known issue with large tables in ClickHouse 24.9.3
- Partial snapshot completion without error
- **Fix:** Check ClickHouse GitHub issues, consider upgrade

### E. Articles Soft-Deleted
- If articles table has deleted_at, PG COUNT(*) excludes them but CH replica includes
- **Fix:** Update PG query to match CH replica scope

### F. Data Type Conversion Issues
- Some articles have data that fails conversion (e.g., invalid UTF-8, large blobs)
- Silent failures during replication
- **Fix:** Check error logs, fix data, resync

## Recommended Investigation Order

1. **Quick checks first:**
   - Run `OPTIMIZE TABLE pg.articles FINAL` and recount
   - Check `COUNT(DISTINCT id)` vs `COUNT(*)`
   - Look for recent errors in CH logs

2. **If still mismatched:**
   - Compare oldest/newest articles in both systems
   - Check articles created during sync window
   - Check for soft-delete columns

3. **Deep investigation:**
   - Export and compare ID lists
   - Analyze missing article patterns (date ranges, sources, etc.)
   - Check table statistics and replication slot status

4. **If no clear cause:**
   - Consider recreating pg database for fresh snapshot
   - Check ClickHouse version for known bugs
   - Monitor if gap grows/shrinks over time

## Success Criteria

- **Target:** 100% row count match (or documented explanation for acceptable difference)
- **Verification:** `COUNT(*)` in both systems matches within acceptable threshold (<0.01%)
- **Monitoring:** Set up alert if counts diverge beyond threshold

## Next Steps

After investigation completes:
1. Document root cause
2. Implement fix
3. Verify 100% sync
4. Add monitoring to prevent future drift
5. Update ARTICLE_IN_CH.md with lessons learned
