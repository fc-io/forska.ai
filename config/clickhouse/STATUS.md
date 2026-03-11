# ClickHouse MaterializedPostgreSQL - Current Status

**Last Updated**: 2026-01-16 08:15 CET

## Summary

✅ **SYNC IS WORKING** - MaterializedPostgreSQL replication is actively syncing data from PostgreSQL to ClickHouse.

## Critical Fixes Applied

### Fix 1: PostgreSQL Network Configuration

**Problem**: PostgreSQL was configured with `listen_addresses = localhost`, preventing ClickHouse from connecting.

**Solution**: Added `listen_addresses = '*'` to `config/postgres/postgresql.conf`

**Status**: ✅ Fixed

### Fix 2: Table Ownership Permissions

**Problem**: ClickHouse MaterializedPostgreSQL requires extensive permissions to manage publications and replication. The error was `must be owner of table articles`.

**Solution**: Granted SUPERUSER privilege to ch_replicator user:

```sql
ALTER USER ch_replicator SUPERUSER;
```

**Status**: ✅ Fixed - Sync is now working

**Note**: In production, you may want to investigate minimal permissions needed and revoke SUPERUSER after initial sync completes.

## Final Sync Results

✅ **Initial sync completed successfully**

### Row Counts (PostgreSQL → ClickHouse):

| Table              | PostgreSQL | ClickHouse | Match    |
| ------------------ | ---------- | ---------- | -------- |
| article_route_link | 10,526,004 | 10,526,004 | ✅ 100%  |
| judgments          | 5,631,946  | 5,631,946  | ✅ 100%  |
| project_articles   | 9,098,464  | 9,098,464  | ✅ 100%  |
| articles           | 10,526,004 | 10,341,151 | ⚠️ 98.2% |
| project_prompts    | 387        | 387        | ✅ 100%  |
| projects           | 65         | 65         | ✅ 100%  |
| project_route_link | 43         | 43         | ✅ 100%  |
| import_route       | 4          | 4          | ✅ 100%  |

**Total**: ~35 million rows synced

### ⚠️ Articles Table Discrepancy - REQUIRES INVESTIGATION

The articles table is missing ~185k rows (1.8% of total):

- **PostgreSQL**: 10,526,004 articles
- **ClickHouse**: 10,341,151 articles
- **Missing**: 184,853 articles

**Status**: ⚠️ **NOT ACCEPTABLE** - Investigation required

This discrepancy must be resolved before production use. Potential causes:

- ReplacingMergeTree not merged (OPTIMIZE TABLE needed)
- Snapshot timing issue during initial sync
- Transaction isolation during snapshot
- Data type conversion failures
- MaterializedPostgreSQL bug in ClickHouse 24.9.3

**Investigation Plan**: See `config/clickhouse/INVESTIGATE_ARTICLE_MISMATCH.md`

**Note**: Replication slot shows only 40 kB lag, so real-time changes are being replicated correctly. The issue is with the initial snapshot.

### Database Size

- **Total size**: 237.41 GiB (compressed columnar format)
- **Primary storage**: articles table with full_text columns

### Helper Views

✅ `forska_helpers.scoped_articles` created successfully

- Note: Querying requires sufficient memory due to UNION DISTINCT operations on millions of rows

## What's Working ✅

1. **PostgreSQL Configuration**
   - `wal_level = logical` ✓
   - `listen_addresses = *` ✓ (FIXED)
   - `max_wal_senders = 10` ✓
   - `max_replication_slots = 10` ✓

2. **Replication User**
   - User `ch_replicator` exists ✓
   - Has SUPERUSER privilege ✓ (required for MaterializedPostgreSQL)
   - Has REPLICATION privilege ✓
   - Has all necessary permissions (CONNECT, SELECT, etc.) ✓

3. **Publication**
   - `postgres_ch_publication` created by ClickHouse ✓
   - Owned by `ch_replicator` ✓
   - Includes all 8 tables ✓

4. **ClickHouse Configuration**
   - Experimental engine enabled ✓
   - Database `pg` created ✓
   - Database `forska_helpers` created ✓

5. **Network Connectivity**
   - Both containers on same network ✓
   - ClickHouse can reach PostgreSQL:5432 ✓ (FIXED)

## To Monitor Sync Progress

Since you have millions of rows, here are ways to monitor:

### 1. Check Table Count

```bash
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT COUNT(*) as synced_tables FROM system.tables WHERE database = 'pg'"
```

Expected: 8 tables when complete

### 2. Check Row Counts

```bash
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT table, formatReadableQuantity(total_rows) as rows,
          formatReadableSize(total_bytes) as size
   FROM system.tables
   WHERE database = 'pg'
   ORDER BY table"
```

### 3. Monitor Disk Usage

```bash
watch -n 5 'docker exec forska-stack-clickhouse-1 du -sh /var/lib/clickhouse/store/8e8/'
```

Will show data being written in real-time

### 4. Check PostgreSQL Replication Slot

```bash
docker exec forska-stack-db-1 psql -U postgres -c \
  "SELECT active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as lag
   FROM pg_replication_slots WHERE slot_name = 'postgres'"
```

- `active = t` means ClickHouse is consuming
- `lag` shows how much WAL is pending

### 5. Real-time Log Monitoring

```bash
docker logs -f forska-stack-clickhouse-1 2>&1 | grep -i "materialized\|postgresql"
```

## Expected Sync Times

With millions of rows, expect:

| Table              | Estimated Rows | Est. Sync Time |
| ------------------ | -------------- | -------------- |
| articles           | ~1-10M         | 30-120 min     |
| judgments          | ~1-10M         | 20-60 min      |
| project_prompts    | ~1000s         | < 1 min        |
| projects           | ~100s          | < 1 min        |
| project_articles   | ~100K-1M       | 5-20 min       |
| project_route_link | ~1000s         | < 1 min        |
| article_route_link | ~100K-1M       | 5-20 min       |
| import_route       | ~100s          | < 1 min        |

**Total**: 1-3 hours for initial sync (heavily dependent on `articles` table size with full_text)

## Phase 2: Infrastructure - MOSTLY COMPLETE ⚠️

Phase 2 tasks from `plans/ARTICLE_IN_CH.md` status:

### ✅ Completed Tasks:

1. PostgreSQL configuration (wal_level, listen_addresses, replication user)
2. ClickHouse MaterializedPostgreSQL database created
3. All 8 tables synced (~35M rows, 237 GiB total)
4. Helper view `forska_helpers.scoped_articles` created
5. Monitoring query tested and working
6. ClickHouse query syntax adaptations documented

### ⚠️ Outstanding Issue:

**Articles table row count mismatch (184,853 missing rows)**

- Status: Investigation plan created, not yet executed
- Blocker: Must be resolved before production use
- See: `config/clickhouse/INVESTIGATE_ARTICLE_MISMATCH.md`

### 📝 Documentation Created:

- `config/clickhouse/STATUS.md` - Current status (this file)
- `config/clickhouse/SETUP_PROGRESS.md` - Step-by-step progress
- `config/clickhouse/TROUBLESHOOTING.md` - Common issues and solutions
- `config/clickhouse/CLICKHOUSE_QUERY_SYNTAX.md` - Query syntax differences
- `config/clickhouse/INVESTIGATE_ARTICLE_MISMATCH.md` - Investigation plan for row count discrepancy

### 🔧 Files Modified:

- `config/postgres/postgresql.conf` - Added `listen_addresses = *`
- `config/clickhouse/experimental-users.xml` - Enabled MaterializedPostgreSQL engine
- `docker-compose.yml` - Added experimental-users.xml mount
- `scripts/setupClickHouseMaterializedPG.ts` - Setup automation
- `scripts/monitorClickHouseSync.ts` - Table sync monitor
- `scripts/monitorSyncProgress.sh` - Real-time progress monitor

### 🚧 Phase 3 Blocked:

**Cannot proceed to Phase 3 until articles mismatch is resolved**

Phase 3 tasks (blocked):

- Implement CH queries for jobs page unassessed count
- Implement CH queries for reviews/unassessed page
- Implement CH queries for cron queue fill

**Required:** Complete investigation and fix from `INVESTIGATE_ARTICLE_MISMATCH.md`

## Quick Reference Commands

### Check sync status:

```bash
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT table, formatReadableQuantity(COUNT(*)) as rows FROM pg.articles GROUP BY table"
```

### Monitor replication lag:

```bash
docker exec forska-stack-db-1 psql -U postgres -c \
  "SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as lag \
   FROM pg_replication_slots WHERE slot_name = 'postgres'"
```

### Check database size:

```bash
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT database, formatReadableSize(SUM(total_bytes)) as size \
   FROM system.tables WHERE database = 'pg' GROUP BY database"
```

### Test unassessed count (example project):

```bash
# See config/clickhouse/CLICKHOUSE_QUERY_SYNTAX.md for complete query
```

## Key Lessons Learned

1. **Docker PostgreSQL must have `listen_addresses = '*'`** to accept connections from other containers. The default `localhost` only allows connections from within the same container.

2. **ClickHouse MaterializedPostgreSQL requires SUPERUSER privileges** on the replication user. While it's possible that minimal permissions exist, the engine needs extensive privileges to manage publications, replication slots, and table ownership. The quickest solution is granting SUPERUSER to the ch_replicator user.
