# ClickHouse MaterializedPostgreSQL Troubleshooting

## Current Status (2026-01-16 07:26)

**Summary**: MaterializedPostgreSQL database created but tables not syncing yet. All prerequisites are correctly configured.

## What's Working ✅

1. **PostgreSQL configuration**:
   - `wal_level = logical` ✓ (verified with `SHOW wal_level`)
   - `max_wal_senders = 10` ✓
   - `max_replication_slots = 10` ✓
   - Config file mounted at `/etc/postgresql/postgresql.conf` ✓

2. **ch_replicator user**:
   - Created with REPLICATION privilege ✓
   - Has CONNECT permission on database ✓
   - Has SELECT on all tables (public, pg_catalog, information_schema) ✓
   - Can connect successfully: `psql -U ch_replicator -d postgres` works ✓

3. **Publication**:
   - Created: `postgres_ch_publication` ✓
   - Includes all 8 tables ✓
   - No WAL warnings (wal_level is logical) ✓

4. **ClickHouse configuration**:
   - Experimental MaterializedPostgreSQL engine enabled ✓
   - Config: `config/clickhouse/experimental-users.xml` ✓
   - Database `pg` created ✓
   - Database `forska_helpers` created ✓

5. **Docker networking**:
   - Containers on same network ✓
   - Using correct service name `db:5432` ✓

## What's Not Working ❌

**Tables aren't appearing in ClickHouse**: `SELECT * FROM system.tables WHERE database = 'pg'` returns empty.

## Last Known Errors

Error log shows old connection failures from 06:25 (when PostgreSQL was being recreated). Since then:
- No new errors in logs (good sign!)
- But also no new activity logs
- ClickHouse may have stopped retrying after many failures

## Quick Diagnostic Commands

```bash
# 1. Check PostgreSQL wal_level
docker exec forska-stack-db-1 psql -U postgres -c "SHOW wal_level"
# Expected: logical

# 2. Check ch_replicator can connect
docker exec forska-stack-db-1 psql -U ch_replicator -d postgres -c "SELECT 1"
# Expected: 1

# 3. Check publication exists
docker exec forska-stack-db-1 psql -U postgres -c "\\dRp+"
# Expected: postgres_ch_publication with 8 tables

# 4. Check ClickHouse database exists
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q "SHOW DATABASES"
# Expected: pg in the list

# 5. Check for tables in pg database
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q "SELECT table, total_rows FROM system.tables WHERE database = 'pg'"
# Expected: 8 tables (currently returns empty)

# 6. Check replication slots
docker exec forska-stack-db-1 psql -U postgres -c "SELECT * FROM pg_replication_slots"
# Shows active replication connections

# 7. Check latest ClickHouse errors
docker exec forska-stack-clickhouse-1 cat /var/log/clickhouse-server/clickhouse-server.err.log | tail -50
```

## Possible Solutions to Try

### Option 1: Force Fresh Start (Most Likely to Work)

```bash
# 1. Drop and recreate pg database in ClickHouse
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q "DROP DATABASE IF EXISTS pg"

# 2. Wait a moment
sleep 5

# 3. Recreate
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q "
CREATE DATABASE pg ENGINE = MaterializedPostgreSQL(
  'db:5432',
  'postgres',
  'ch_replicator',
  'ch_replicator_dev_pass'
) SETTINGS materialized_postgresql_tables_list = 'articles,projects,project_prompts,judgments,project_articles,project_route_link,article_route_link,import_route'"

# 4. Monitor for tables
watch -n 2 'docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q "SELECT table, total_rows FROM system.tables WHERE database = '\''pg'\'' ORDER BY table"'
```

### Option 2: Check ClickHouse Background Tasks

```bash
# Check if background task is running
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q "
SELECT * FROM system.background_pool WHERE database = 'pg'"

# Check metrics
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q "
SELECT * FROM system.metrics WHERE metric LIKE '%PostgreSQL%'"
```

### Option 3: Enable Debug Logging

Add to `config/clickhouse/debug-logging.xml`:
```xml
<?xml version="1.0"?>
<clickhouse>
    <logger>
        <level>debug</level>
    </logger>
</clickhouse>
```

Then:
```bash
docker-compose restart clickhouse
# Watch logs in real-time
docker logs -f forska-stack-clickhouse-1 2>&1 | grep -i "materialized\|postgresql"
```

### Option 4: Manual Publication Verification

```bash
# Test if ch_replicator can read publication
docker exec forska-stack-db-1 psql -U ch_replicator -d postgres -c "
SELECT * FROM pg_publication_tables WHERE pubname = 'postgres_ch_publication'"
# Should show 8 tables
```

## Expected Behavior Once Working

When sync completes, you should see:
```
article_route_link    <row_count>
articles             <row_count>
import_route         <row_count>
judgments            <row_count>
project_articles     <row_count>
project_prompts      <row_count>
project_route_link   <row_count>
projects             <row_count>
```

Initial sync time depends on data volume:
- Small tables (< 1000 rows): seconds
- Medium tables (< 100K rows): ~1-5 minutes
- Large tables (millions of rows, especially `articles` with full_text): ~10-60 minutes

## Next Steps After Sync Completes

1. Create helper views (script ready in `scripts/setupClickHouseMaterializedPG.ts`)
2. Verify row counts match PostgreSQL
3. Check indexes on `pg.articles`
4. Test monitoring queries
5. Monitor disk usage

## Files Created

- `config/clickhouse/experimental-users.xml` - Enables MaterializedPostgreSQL engine
- `scripts/setupClickHouseMaterializedPG.ts` - Setup automation script
- `scripts/monitorClickHouseSync.ts` - Monitoring script
- `config/clickhouse/SETUP_PROGRESS.md` - Detailed progress documentation
- `config/clickhouse/TROUBLESHOOTING.md` - This file

## Contact/Notes

If stuck, ClickHouse community resources:
- GitHub issues: https://github.com/ClickHouse/ClickHouse/issues
- Slack: https://clickhouse.com/slack
- Search for "MaterializedPostgreSQL" issues

Common gotchas we've already handled:
- ✅ wal_level must be 'logical' (not 'replica')
- ✅ ch_replicator needs REPLICATION privilege
- ✅ ch_replicator needs CONNECT on database
- ✅ Publication must exist before sync
- ✅ Docker service names (not localhost)
- ✅ Experimental engine must be enabled in users.d
