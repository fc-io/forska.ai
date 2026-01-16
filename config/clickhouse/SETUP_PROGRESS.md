# ClickHouse MaterializedPostgreSQL Setup Progress

## ✅ Completed Steps

### 1. ClickHouse Configuration
- **Created**: `config/clickhouse/experimental-users.xml`
  - Enables `allow_experimental_database_materialized_postgresql` setting
  - Mounted in Docker at: `/etc/clickhouse-server/users.d/experimental-users.xml`
- **Updated**: `docker-compose.yml` to mount the experimental config file
- **Status**: ClickHouse successfully loads the experimental setting ✓

### 2. PostgreSQL Replication User
- **Created**: `ch_replicator` user with REPLICATION privileges
- **Password**: `ch_replicator_dev_pass` (dev environment)
- **Grants**:
  - `USAGE` on `public` schema
  - `SELECT` on all existing tables
  - `SELECT` on future tables (via `ALTER DEFAULT PRIVILEGES`)
- **Location**: Created manually via `docker exec`
  - Note: `/init-db/002-ch-replication-user.sql` exists but wasn't run (database was already initialized)

### 3. ClickHouse Databases
- **Created**: `pg` database with MaterializedPostgreSQL engine
  - Connection: `db:5432` (Docker service name)
  - Database: `postgres`
  - User: `ch_replicator`
  - Tables list: `articles,projects,project_prompts,judgments,project_articles,project_route_link,article_route_link,import_route`
- **Created**: `forska_helpers` database for views/CTEs

### 4. Scripts
- **Created**: `scripts/setupClickHouseMaterializedPG.ts`
  - Automates database creation and view setup
  - Note: Uses `localhost` host, which works for local development but not for Docker-to-Docker communication
- **Created**: `scripts/monitorClickHouseSync.ts`
  - Monitors table sync progress from PostgreSQL

## 🔄 In Progress

### MaterializedPostgreSQL Sync
- **Status**: Waiting for tables to sync from PostgreSQL
- **Issue encountered**: Permission errors when checking Docker daemon
- **Resolution**: Restart Docker or wait for temporary issue to resolve

## ⏭️ Remaining Steps (Phase 2)

### 1. Verify Initial Sync
```bash
# Check synced tables and row counts
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT database, table, total_rows FROM system.tables WHERE database = 'pg' ORDER BY table"

# Expected output: 8 tables (articles, projects, project_prompts, judgments, project_articles, project_route_link, article_route_link, import_route)
```

### 2. Create Helper Views
Once tables are synced, create the `scoped_articles` view:

```bash
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q "
CREATE OR REPLACE VIEW forska_helpers.scoped_articles AS
SELECT project_id, article_id FROM pg.project_articles
UNION DISTINCT
SELECT prl.project_id, arl.article_id
FROM pg.project_route_link prl
JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id
UNION DISTINCT
SELECT prl.project_id, a.id AS article_id
FROM pg.project_route_link prl
JOIN pg.import_route ir ON prl.import_route_id = ir.id
JOIN pg.articles a ON a.import_route = ir.route
"
```

### 3. Verify Row Counts
Compare row counts between PostgreSQL and ClickHouse:

```bash
# PostgreSQL
docker exec forska-stack-db-1 psql -U postgres -c \
  "SELECT 'projects' AS tbl, COUNT(*) FROM projects
   UNION ALL SELECT 'judgments', COUNT(*) FROM judgments
   UNION ALL SELECT 'project_articles', COUNT(*) FROM project_articles"

# ClickHouse
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT 'projects' AS tbl, COUNT(*) FROM pg.projects
   UNION ALL SELECT 'judgments', COUNT(*) FROM pg.judgments
   UNION ALL SELECT 'project_articles', COUNT(*) FROM pg.project_articles"
```

### 4. Verify Indexes
Check if the required index exists on `pg.articles`:

```bash
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SHOW CREATE TABLE pg.articles"
```

Look for index on `(article_updated_at, article_id)`. If missing, MaterializedPostgreSQL should replicate indexes from PostgreSQL automatically.

### 5. Test Monitoring Query
Verify the replication lag monitoring query works:

```bash
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT database, table, total_rows FROM system.tables WHERE database = 'pg'"
```

### 6. Monitor Disk Usage
Check ClickHouse disk usage after initial sync:

```bash
# Data directory size
docker exec forska-stack-clickhouse-1 du -sh /var/lib/clickhouse/store/

# Per-table sizes
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT database, table,
          formatReadableSize(sum(bytes)) as size,
          formatReadableSize(sum(bytes_on_disk)) as compressed_size
   FROM system.parts
   WHERE database = 'pg'
   GROUP BY database, table
   ORDER BY sum(bytes) DESC"
```

## 📝 Notes

### Docker Network Communication
- ClickHouse container must use `db:5432` (service name) to connect to PostgreSQL
- `localhost` refers to the container itself, not the host machine
- Both containers are in the `forska-stack` Docker network

### MaterializedPostgreSQL Behavior
- Initial sync can take minutes to hours depending on data volume (especially `articles` table with full_text)
- Replication lag expected: 1-5 seconds under normal operation
- Tables appear in `system.tables` only after initial sync completes

### Troubleshooting
If sync doesn't start, check ClickHouse error log:
```bash
docker exec forska-stack-clickhouse-1 cat /var/log/clickhouse-server/clickhouse-server.err.log | grep -i "materialized\|postgresql\|replication" | tail -20
```

Common issues:
- **Password authentication failed**: Check ch_replicator user exists and has correct password
- **Connection refused**: Check PostgreSQL host (should be `db:5432` in Docker)
- **Permission denied**: Check ch_replicator has SELECT grants on all tables

## ✅ Quick Resume Commands

After Docker permission issue is resolved:

```bash
# 1. Check if tables are synced
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "SELECT table, total_rows FROM system.tables WHERE database = 'pg' ORDER BY table"

# 2. If synced, create helper views
docker exec forska-stack-clickhouse-1 clickhouse-client --password clickhouse -q \
  "CREATE OR REPLACE VIEW forska_helpers.scoped_articles AS
   SELECT project_id, article_id FROM pg.project_articles
   UNION DISTINCT
   SELECT prl.project_id, arl.article_id
   FROM pg.project_route_link prl
   JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id
   UNION DISTINCT
   SELECT prl.project_id, a.id AS article_id
   FROM pg.project_route_link prl
   JOIN pg.import_route ir ON prl.import_route_id = ir.id
   JOIN pg.articles a ON a.import_route = ir.route"

# 3. Verify row counts match
# (See "Verify Row Counts" section above)
```
