# ARTICLE_IN_CH — MaterializedPostgreSQL plan

Goal: CH has *exact* project-scope articles + judgments state, continuously from Postgres, to power:
- Jobs page: Unassessed Articles count (`/api/judgmentsjobs-unassessed-count`)
- Project Reviews Unassessed page: list+count (`/api/articlesreviewsunassessed`)
- Cron queue fill: ready (article×prompt) pairs (`src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`)

```
┌─────────────┐      WAL Stream       ┌─────────────────────────────┐
│  PostgreSQL │ ──────────────────►  │  ClickHouse                 │
│             │   (logical repl)      │  MaterializedPostgreSQL DB  │
│  - projects │                       │  (pg.*)                     │
│  - articles │   Replication Slot    │                             │
│  - judgments│ ◀─ tracks position ─► │  Near real-time replica     │
│  - scopes   │                       │  (expect 1-5s lag)          │
└─────────────┘                       └─────────────────────────────┘
```

---

## Definitions (canonical semantics)

### Project scope articles

> ⚠️ **Schema note**: FK column is `import_route_id` (not `route_id`). Cron currently has 3 paths; CH should use canonical 2-way union only. Document legacy path as deprecated.

**Canonical scope** (2-way union):
```sql
-- Path 1: Direct article assignment
SELECT article_id FROM project_articles WHERE project_id = ?
UNION
-- Path 2: Via import_route FK
SELECT arl.article_id
FROM project_route_link prl
JOIN article_route_link arl ON arl.import_route_id = prl.import_route_id
WHERE prl.project_id = ?
```

**Legacy path (cron only, deprecated)**:
```sql
-- Path 3: Legacy string-match on articles.import_route → import_route.route
SELECT a.id AS article_id
FROM project_route_link prl
JOIN import_route ir ON prl.import_route_id = ir.id
JOIN articles a ON a.import_route = ir.route
WHERE prl.project_id = ?
```

> 🔧 **TODO**: Backfill `article_route_link` for legacy articles, then remove Path 3 from cron. CH should NOT replicate legacy path — use canonical 2-way union only.

### "Assessed" judgment

A judgment qualifies as "assessed" if **all** are true:
1. `deleted_at IS NULL`
2. `is_answered = true`
3. Content settings match project: `(model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)` = project values
4. `prompt_id` ∈ enabled prompts (from `project_prompts WHERE enabled = true`)

> ⚠️ **Current PG inconsistencies**:
> - `JudgmentsJobsRoutes.ts` (line ~124): Jobs count join does NOT filter `is_answered`, `deleted_at`, or `project_prompts.enabled`
> - `projectsRoutesGetArticlesReviewsUnassessed.ts` (line ~84): Reviews join does NOT filter `is_answered` or `deleted_at`
> - `judgmentsJobsCronGetPrompts.ts` (line ~67): Cron NOT EXISTS correctly filters `is_answered = true` but NOT `deleted_at`
>
> **Resolution before CH**: Unify PG queries to enforce all 4 conditions. CH will then match.

### "Unassessed" article

Article is "unassessed" if missing ≥1 assessed judgment for any enabled prompt.

### Edge case: 0 enabled prompts

> ⚠️ If a project has 0 enabled prompts:
> - CH spot-check query returns ALL scoped articles as unassessed (because `assessed` CTE is empty)
> - Current cron returns early with `{promptEntries: []}` (line ~144)
>
> **CH behavior**: Query should return 0 unassessed (no prompts = nothing to assess). Add guard:
> ```sql
> -- Return 0 if no enabled prompts
> SELECT CASE WHEN (SELECT COUNT(*) FROM enabled_prompts) = 0 THEN 0
>        ELSE (SELECT COUNT(*) FROM unassessed) END AS unassessed_count
> ```

---

## Tables to replicate in ClickHouse

> ⚠️ **Storage concern**: `articles` table has heavy columns (`full_text`, `full_text_html`, `full_text_pdf`, `full_text_assets`). MaterializedPostgreSQL replicates ALL columns → high storage/WAL/ingest cost that may dwarf query wins.

**Approach: Hydrate from PG**
Do NOT replicate articles at all. Query CH for article IDs only, then hydrate metadata from Postgres via `WHERE id IN (...)`. Avoids trigger overhead + extra table.

| Postgres Table         | Key Columns                                                         | Notes                          |
|------------------------|---------------------------------------------------------------------|--------------------------------|
| `projects`             | `id`, `model_id`, `date_from`, `date_to`, `use_*`, `archived` | Small, replicate fully |
| `project_prompts`      | `project_id`, `prompt_id`, `enabled`                                | Small, replicate fully |
| `judgments`            | `article_id`, `prompt_id`, `model_id`, `is_answered`, `deleted_at`, `use_*` | Main assessment table |
| `project_articles`     | `project_id`, `article_id`                                          | Direct scope link              |
| `project_route_link`   | `project_id`, `import_route_id`                                     | Note: FK is `import_route_id`  |
| `article_route_link`   | `article_id`, `import_route_id`                                     | Note: FK is `import_route_id`  |
| `import_route`         | `id`, `route`                                                       | Only if keeping legacy path    |

---

## Infrastructure setup

### 1) PostgreSQL: enable logical replication
```ini
# postgresql.conf
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
```

Create replication user with default privileges (so new tables don't break replication):
```sql
CREATE USER ch_replicator WITH REPLICATION PASSWORD 'xxx';

-- Grant on existing tables
GRANT USAGE ON SCHEMA public TO ch_replicator;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ch_replicator;

-- Grant on future tables (critical: prevents breaks when new tables are created)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ch_replicator;
```

> ⚠️ **WAL growth**: If CH consumer lags or goes offline, the replication slot holds WAL.
> Monitor with: `SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots;`

### 2) ClickHouse: create MaterializedPostgreSQL database

> ⚠️ **Table list must be complete at creation time.**

```sql
CREATE DATABASE pg ENGINE = MaterializedPostgreSQL(
  'postgres-host:5432',
  'forska_db',
  'ch_replicator',
  'xxx'
) SETTINGS materialized_postgresql_tables_list = 'projects,project_prompts,judgments,project_articles,project_route_link,article_route_link';
```

> 📌 Use a separate DB name (`pg`) to avoid collision with existing `forska.judgments` (Parquet-based).

### 3) Separate database for views/helpers

> ⚠️ MaterializedPostgreSQL databases may not support creating views directly in `pg.*`. CH behavior varies by version.

**Recommended**: Create a separate normal DB for helper views:
```sql
CREATE DATABASE forska_helpers;

-- Helper views reference pg.* tables
CREATE VIEW forska_helpers.scoped_articles AS
SELECT project_id, article_id FROM pg.project_articles
UNION DISTINCT
SELECT prl.project_id, arl.article_id
FROM pg.project_route_link prl
JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id;
```

### 4) Verification queries

**Row count sanity:**
```sql
-- In Postgres
SELECT 'projects' AS tbl, COUNT(*) FROM projects
UNION ALL SELECT 'judgments', COUNT(*) FROM judgments
UNION ALL SELECT 'project_articles', COUNT(*) FROM project_articles;

-- In ClickHouse
SELECT 'projects' AS tbl, COUNT(*) FROM pg.projects
UNION ALL SELECT 'judgments', COUNT(*) FROM pg.judgments
UNION ALL SELECT 'project_articles', COUNT(*) FROM pg.project_articles;
```

**Per-project spot check (compare unassessed counts):**
```sql
-- ClickHouse: unassessed count for project X
WITH
  scoped AS (
    SELECT article_id FROM pg.project_articles WHERE project_id = 'X'
    UNION DISTINCT
    SELECT arl.article_id
    FROM pg.project_route_link prl
    JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id
    WHERE prl.project_id = 'X'
  ),
  enabled_prompts AS (
    SELECT prompt_id FROM pg.project_prompts WHERE project_id = 'X' AND enabled = true
  ),
  assessed AS (
    SELECT j.article_id
    FROM pg.judgments j
    JOIN pg.projects p ON p.id = 'X'
    WHERE j.deleted_at IS NULL
      AND j.is_answered = true
      AND j.model_id = p.model_id
      AND j.use_title = p.use_title
      AND j.use_abstract = p.use_abstract
      AND j.use_fulltext = p.use_fulltext
      AND j.use_fulltext_no_images = p.use_fulltext_no_images
      AND j.prompt_id IN (SELECT prompt_id FROM enabled_prompts)
    GROUP BY j.article_id
    HAVING countDistinct(j.prompt_id) = (SELECT COUNT(*) FROM enabled_prompts)
  )
SELECT
  CASE WHEN (SELECT COUNT(*) FROM enabled_prompts) = 0 THEN 0
       ELSE (SELECT COUNT(*) FROM scoped s WHERE s.article_id NOT IN (SELECT article_id FROM assessed))
  END AS unassessed_count;
```

---

## ClickHouse query building blocks

Create in `forska_helpers` DB (not `pg.*`):

| Function | Returns | Notes |
|----------|---------|-------|
| `scoped_article_ids(projectId)` | `DISTINCT article_id` | 2-way union (direct + route-based) |
| `enabled_prompt_ids(projectId)` | `Array(UUID)` or subquery | From `project_prompts WHERE enabled = true` |
| `assessed_article_ids(projectId)` | `DISTINCT article_id` | Articles with ALL enabled prompts judged |
| `unassessed_article_ids(projectId)` | `DISTINCT article_id` | `scoped - assessed` (guard for 0 prompts) |

---

## Feature implementations

> On CH error/unavailable → fall back to Postgres queries (circuit breaker).

### 1) Jobs page: unassessed count
**Current**: Heavy Postgres query with cross join + NOT EXISTS.

**CH strategy**:
1. Keep job context fetch in Postgres (`jobId → projectId`) — fast, single row
2. Compute in CH: `unassessed_count = scoped_count - fully_assessed_count`
3. Guard: return 0 if 0 enabled prompts
4. Keep existing 10s cache (can relax after perf confirmation)

### 2) Jobs page: unassessed articles list
**CH strategy**:
1. Query `unassessed_article_ids(projectId)` with pagination
2. Order by `article_updated_at DESC` (canonical sort column)
3. Return IDs from CH, hydrate from Postgres via `WHERE id IN (...)` (limit 100)

### 3) Project Reviews Unassessed page
**Endpoint**: `/api/articlesreviewsunassessed`

**CH strategy**:
1. CH query for count + paginated article IDs
2. Prefer keyset pagination for large scopes:
   ```sql
   WHERE (article_updated_at, article_id) < (?, ?)
   ORDER BY article_updated_at DESC, article_id DESC
   LIMIT 100
   ```
3. Offset pagination acceptable if scope < 100k articles

### 4) Cron: `judgmentsJobsCronGetPrompts`
**Goal**: Avoid Postgres cross join + NOT EXISTS scans.

**CH strategy**:
```sql
WITH
  scoped AS (
    SELECT article_id FROM pg.project_articles WHERE project_id = ?
    UNION DISTINCT
    SELECT arl.article_id
    FROM pg.project_route_link prl
    JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id
    WHERE prl.project_id = ?
  ),
  enabled_prompts AS (
    SELECT prompt_id FROM pg.project_prompts WHERE project_id = ? AND enabled = true
  ),
  -- assessed returns (article_id, prompt_id) pairs, not just article_id
  assessed_pairs AS (
    SELECT j.article_id, j.prompt_id
    FROM pg.judgments j
    JOIN pg.projects p ON p.id = ?
    WHERE j.deleted_at IS NULL
      AND j.is_answered = true
      AND j.model_id = p.model_id
      AND j.use_title = p.use_title
      AND j.use_abstract = p.use_abstract
      AND j.use_fulltext = p.use_fulltext
      AND j.use_fulltext_no_images = p.use_fulltext_no_images
      AND j.prompt_id IN (SELECT prompt_id FROM enabled_prompts)
  )
SELECT s.article_id, ep.prompt_id
FROM scoped s
CROSS JOIN enabled_prompts ep
LEFT JOIN assessed_pairs ap ON ap.article_id = s.article_id AND ap.prompt_id = ep.prompt_id
WHERE ap.article_id IS NULL
LIMIT 1000
-- Then in PG: SELECT * FROM articles WHERE id IN (...) ORDER BY article_updated_at DESC
```

Insert to `judgments_jobs_prompts` with conflict handling:
```ts
await db.insert(judgmentsJobsPrompts)
  .values(pairs)
  .onConflictDoNothing();
```

> ⚠️ **Replication lag caveat**: CH may return pairs that were *just* judged in Postgres.
> `onConflictDoNothing` prevents duplicates. Downstream worker checks if already judged (no-op if so).

---

## Monitoring & alerting

### Replication lag

> ⚠️ **Version check**: `system.postgres_replication_slots` view may not exist or may have different columns depending on CH version. Test in target environment first.

**Option A (if `system.postgres_replication_slots` exists)**:
```sql
SELECT database, table, total_lag_seconds
FROM system.postgres_replication_slots
WHERE database = 'pg';
```

**Option B (check MaterializedPostgreSQL status)**:
```sql
SELECT name, value FROM system.settings WHERE name LIKE 'materialized_postgresql%';
-- Or check database replication status via system tables
```

**Option C (compare row counts)**:
```sql
-- Compare PG vs CH counts as proxy for lag
-- Run periodically and alert if delta persists > 60s
```

Add to runtime logging:
```ts
// Verify query works in your CH version before using
const lagQuery = `SELECT max(total_lag_seconds) as lag FROM system.postgres_replication_slots WHERE database = 'pg'`;
const lag = await clickhouse.query(lagQuery).catch(() => null);
if (lag) logger.info({ chReplicationLagSec: lag }, 'CH replication status');
```

**Alert thresholds**:
- ⚠️ Warning: lag > 10s
- 🚨 Critical: lag > 60s → consider fallback to Postgres

### WAL slot size (Postgres side)
```sql
SELECT slot_name,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as lag_bytes
FROM pg_replication_slots
WHERE slot_type = 'logical';
```

**Alert**: WAL lag > 1GB → CH consumer unhealthy

---

## Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Scope mismatch** | CH uses 2-way union; PG cron uses 3-way | Backfill `article_route_link`, then deprecate legacy path |
| **Assessed semantics drift** | CH/PG counts differ | Unify PG queries first (`is_answered`, `deleted_at`, `enabled`) |
| **0 enabled prompts** | CH returns all articles as unassessed | Add guard clause in queries |
| **Full articles replication** | Storage/WAL bloat | Hydrate from PG (do not replicate articles) |
| **Views in MaterializedPG DB** | May fail or behave unexpectedly | Use separate `forska_helpers` DB |
| **Monitoring query** | `system.postgres_replication_slots` may not exist | Test in target CH version; fallback to row count comparison |
| **Replication lag** | Stale counts, missed articles | Accept 1-5s lag; fallback to Postgres for user-facing actions |
| **WAL growth** | Disk full on Postgres | Monitor slot size; alert on > 1GB; emergency slot drop procedure |
| **Type mapping** | UUID/timestamp mismatches | Explicit casts in CH queries; verify with test data |

---

## Pre-flight checklist (before implementing CH)

- [ ] **Unify PG "assessed" semantics**: Update `JudgmentsJobsRoutes.ts` and `projectsRoutesGetArticlesReviewsUnassessed.ts` to filter `is_answered = true`, `deleted_at IS NULL`, and `project_prompts.enabled = true`
- [ ] **Backfill `article_route_link`**: Populate for legacy `articles.import_route` values
- [ ] **Deprecate legacy scope path**: Remove 3rd path from cron after backfill complete
- [ ] **Verify CH version**: Check if `system.postgres_replication_slots` exists with expected columns

---

## Rollout plan

### Phase 1: PG cleanup
- [ ] Unify assessed semantics in all PG queries (add `is_answered`, `deleted_at`, `enabled` filters)
- [ ] Backfill `article_route_link` for legacy articles

### Phase 2: Infrastructure
- [ ] Enable logical replication in Postgres
- [ ] Create CH replication user with appropriate grants
- [ ] Create `pg` database in ClickHouse (excluding full `articles`)
- [ ] Create `forska_helpers` database for views
- [ ] Verify row counts match between PG and CH
- [ ] Confirm monitoring query works in CH version

### Phase 3: Deploy
- [ ] Implement CH queries (replaces Postgres queries directly)
- [ ] Add 0-prompt guard to all queries
- [ ] Deploy to production
- [ ] Observe query latency

### Phase 4: Evaluate
- [ ] Compare CH vs PG counts for sample projects
- [ ] If noticeable improvement → done
- [ ] If no improvement or issues → revert commit, reassess approach
