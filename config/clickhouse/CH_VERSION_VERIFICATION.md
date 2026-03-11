# ClickHouse 24.9 MaterializedPostgreSQL Verification

**Date**: 2026-01-15
**ClickHouse Version**: 24.9 (configured in docker-compose.yml)

## Summary

✅ ClickHouse 24.9 **supports MaterializedPostgreSQL** with all core features needed for the ARTICLE_IN_CH plan.

⚠️ **Version 24.9 is NOT an LTS release** (24.8 is the latest LTS). Consider upgrading to 24.8 LTS for production use.

## Key Features Verified

### Supported Features

- ✅ MaterializedPostgreSQL database engine
- ✅ Logical replication via PostgreSQL WAL
- ✅ Initial snapshot + CDC (Change Data Capture)
- ✅ Dynamic table management (ATTACH/DETACH)
- ✅ Selective column replication (added in 24.9 - PR #69092)
- ✅ Schema flexibility (single/multiple schemas)

### Requirements Met

- ✅ `wal_level = logical` (configured in config/postgres/postgresql.conf)
- ✅ `max_replication_slots >= 2` (set to 10 in our config)
- ✅ `max_wal_senders >= 1` (set to 10 in our config)

### Monitoring Capabilities

⚠️ **`system.postgres_replication_slots` NOT documented** in official MaterializedPostgreSQL docs

As noted in `plans/ARTICLE_IN_CH.md` lines 450-462:

> ⚠️ **Version check**: `system.postgres_replication_slots` view may not exist or may have different columns depending on CH version. Test in target environment first.

**Recommendation**: Use Option B or C from `plans/ARTICLE_IN_CH.md`:

- Option B: Check MaterializedPostgreSQL database status via `system.databases`
- Option C: Compare row counts between PG and CH as lag proxy

## Important Limitations

1. **No DDL replication**: Column type changes or structural modifications break replication
2. **No TOAST support**: Large values (>2KB) may not replicate correctly
3. **Manual table discovery**: New PostgreSQL tables aren't automatically detected (must be in `materialized_postgresql_tables_list` at creation)
4. **No automatic views**: Cannot create views in MaterializedPostgreSQL databases (use separate `forska_helpers` DB as planned)

## Recent Fixes in 24.9

- Replication of subset of columns (PR #69092)

## Recent Fixes in 24.8 LTS

- Fixed error on generated columns when adnum ordering is broken
- Fixed error on id column with nextval expression as default
- Fixed error on dropping publication with symbols except [a-z1-9-]

## PostgreSQL Requirements

Configured in `config/postgres/postgresql.conf` and `init-db/002-ch-replication-user.sql`:

- ✅ Replication user created: `ch_replicator`
- ✅ Grants: USAGE on schema, SELECT on all tables + future tables
- ✅ Default privileges for postgres and forska_admin roles

## Recommendation

**Consider upgrading to ClickHouse 24.8 LTS** for production use:

- Change `docker-compose.yml` line 36 from `clickhouse/clickhouse-server:24.9` to `clickhouse/clickhouse-server:24.8`
- 24.8 is LTS (12 months support) and includes all MaterializedPostgreSQL fixes
- 24.9 is a regular release with shorter support window

## Next Steps

Per `plans/ARTICLE_IN_CH.md` Phase 2:

- [ ] **Initial sync**: Estimate ~1-10 min per million articles (full_text + network dependent); 10M articles ≈ 2-6 hours. Run `CREATE DATABASE` command (dev system, no scheduling needed)
- [ ] Create `pg` database in ClickHouse with full `articles` table (C.1 approach)
- [ ] Create `forska_helpers` database for views/CTEs
- [ ] Verify row counts match between PG and CH
- [ ] Verify index on `pg.articles (article_updated_at, article_id)` exists
- [ ] Confirm monitoring query works (test all Options A/B/C)
- [ ] Monitor CH disk usage after initial sync

## Sources

- [MaterializedPostgreSQL | ClickHouse Docs](https://clickhouse.com/docs/engines/database-engines/materialized-postgresql)
- [ClickHouse 24.9 Release](https://clickhouse.com/videos/202409-release-call)
- [2024 Changelog | ClickHouse Docs](https://clickhouse.com/docs/whats-new/changelog/2024)
- [ClickHouse Release 24.8 LTS](https://clickhouse.com/blog/clickhouse-release-24-08)
