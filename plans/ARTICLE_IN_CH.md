# ARTICLE_IN_CH — MaterializedPostgreSQL plan

LEGACY. Current PG→CH sync uses PeerDB; manual scripts/routes removed. See `PG_CH_HEALTH.md`.

Goal: CH has _exact_ project-scope articles + judgments state, continuously from Postgres, to power:

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

**Legacy path (kept for compatibility)**:

```sql
-- Path 3: Legacy string-match on articles.import_route → import_route.route
SELECT a.id AS article_id
FROM project_route_link prl
JOIN import_route ir ON prl.import_route_id = ir.id
JOIN articles a ON a.import_route = ir.route
WHERE prl.project_id = ?
```

> 📌 **Legacy path status**: Path 3 matches current cron behavior. CH replicates `import_route` table to support this. Future work: harmonize to FK-only approach (Paths 1+2) once all articles have `article_route_link` entries.

### "Assessed" judgment

A judgment qualifies as "assessed" if **all** are true:

1. `deleted_at IS NULL`
2. `is_answered = true`
3. Content settings match project: `(model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)` = project values
4. `prompt_id` ∈ enabled prompts (from `project_prompts WHERE enabled = true AND archived = false`)

> ⚠️ **`project_prompts` semantics**: Both `enabled` and `archived` columns exist. A prompt is considered "active" only when `enabled = true AND archived = false`. Ensure CH and PG queries agree on this to prevent drift.

> ⚠️ **Current PG inconsistencies**:
>
> - `JudgmentsJobsRoutes.ts` (line ~124): Jobs count join does NOT filter `is_answered`, `deleted_at`, or `project_prompts.enabled`
> - `projectsRoutesGetArticlesReviewsUnassessed.ts` (line ~84): Reviews join does NOT filter `is_answered` or `deleted_at`
> - `judgmentsJobsCronGetPrompts.ts` (line ~67): Cron NOT EXISTS correctly filters `is_answered = true` but NOT `deleted_at`
>
> **Resolution before CH**: Unify PG queries to enforce all 4 conditions. CH will then match.

### "Unassessed" article

Article is "unassessed" if missing ≥1 assessed judgment for any enabled prompt.

### Edge case: 0 enabled prompts

> ⚠️ If a project has 0 enabled prompts:
>
> - CH spot-check query returns ALL scoped articles as unassessed (because `assessed` CTE is empty)
> - Current cron returns early with `{promptEntries: []}` (line ~144)
>
> **CH behavior**: Query should return 0 unassessed (no prompts = nothing to assess). Add guard:
>
> ```sql
> -- Return 0 if no enabled prompts
> SELECT CASE WHEN (SELECT COUNT(*) FROM enabled_prompts) = 0 THEN 0
>        ELSE (SELECT COUNT(*) FROM unassessed) END AS unassessed_count
> ```

---

## Tables to replicate in ClickHouse

### Articles replication options

The `articles` table has heavy columns (`full_text`, `full_text_html`, `full_text_pdf`, `full_text_assets`) that impact storage and WAL bandwidth (the volume of data streamed over PostgreSQL's logical replication — larger rows = more network/disk I/O per change). Choose one of three approaches:

| Option                     | What's replicated        | CH Storage        | WAL Bandwidth | Sort in CH? | Hydrate from PG?             |
| -------------------------- | ------------------------ | ----------------- | ------------- | ----------- | ---------------------------- |
| **(A) No replication**     | Nothing                  | None              | None          | ❌ No       | ✅ Full (IDs + all metadata) |
| **(B) Skinny replica**     | `id`, timestamps only    | ~50-100 bytes/row | Low           | ✅ Yes      | ✅ Title/abstract/etc.       |
| **(C.2) Metadata replica** | All except `full_text_*` | ~1-5 KB/row       | Medium        | ✅ Yes      | ❌ Not needed                |
| **(C.1) Full replica**     | All columns              | ~10-500 KB/row    | High          | ✅ Yes      | ❌ Not needed                |

**Option A: No replication (hydrate from PG)**

- Query CH for article IDs only, then hydrate from Postgres via `WHERE id IN (...)`
- ⚠️ CH cannot sort by `article_updated_at` — each hydrated batch from PG is sorted independently
- Works well for **count-only endpoints**; causes page-boundary inconsistencies for **paginated lists**

**Option B: Skinny replica (recommended for list/pagination)**

- Replicate only `articles.id`, `article_created_at`, `article_updated_at`
- Enables correct `ORDER BY article_updated_at DESC` pagination in CH
- Still hydrate title, abstract, etc. from PG after getting sorted IDs
- Requires a **PostgreSQL view or separate table** since MaterializedPostgreSQL replicates all columns by default:

  ```sql
  -- Option B.1: Create a view (CH may not support replicating views — check version)
  CREATE VIEW articles_skinny AS SELECT id, article_created_at, article_updated_at FROM articles;

  -- Option B.2: Trigger-maintained shadow table (more complex but guaranteed to work)
  CREATE TABLE articles_ch_sync (id UUID PRIMARY KEY, article_created_at TIMESTAMPTZ, article_updated_at TIMESTAMPTZ);
  -- + INSERT/UPDATE/DELETE triggers on articles
  ```

**Option C: Full replication**

- Replicate the `articles` table to avoid any PG hydration round-trips
- Maximum query flexibility in CH (search, sort, filter all in one place)
- Two sub-approaches:

  ```sql
  -- Option C.1: True full replication (includes full_text columns)
  -- Just add 'articles' to materialized_postgresql_tables_list
  -- ⚠️ High storage: 10-500 KB/row × millions of articles
  -- ⚠️ High WAL bandwidth: full payload on every INSERT/UPDATE
  -- Use when: you want full-text search in CH, or have few articles

  -- Option C.2: Metadata-only replication (excludes heavy columns)
  -- Replicate everything EXCEPT full_text, full_text_html, full_text_pdf, full_text_assets
  -- Requires view or shadow table (like Option B) since MaterializedPostgreSQL can't exclude columns:
  CREATE VIEW articles_metadata AS
  SELECT id, article_created_at, article_updated_at, title, abstract, doi,
         openalex_id, import_route, source_url, source_name /* etc - all except full_text_* */
  FROM articles;
  -- OR trigger-maintained shadow table

  -- Use when: you want title/abstract in CH for filtering, but not full-text storage cost
  ```

**Recommendation: C.1 (full replication)**

The idiomatic ClickHouse approach — just replicate everything:

- ✅ **Simplest setup**: Just add `articles` to the table list, no views/triggers needed
- ✅ CH can sort, filter, and display article lists without PG round-trips
- ✅ Columnar storage: unused columns (full_text) don't hurt query performance
- ✅ Compression shrinks text 5-10×, so storage cost is manageable
- ⚠️ Higher WAL bandwidth during initial sync and on article updates
- ⚠️ Monitor disk usage; scale CH storage if needed

**Potential downsides of C.1:**

| Downside              | Impact                                               | Mitigation                                                 |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| **Initial sync time** | Large articles table × full rows = longer first sync | One-time cost; run during low-traffic window               |
| **WAL bandwidth**     | Full row sent on every UPDATE                        | Acceptable if article updates are infrequent               |
| **Disk usage**        | ~10-500 KB/article before compression                | Compression helps; monitor and scale storage               |
| **Replication lag**   | CH lags PG by 1-5s                                   | Accept as-is; 1-5s lag expected for MaterializedPostgreSQL |

Fallback: If storage becomes a concern, switch to C.2 (metadata-only) or B (skinny + PG hydration).

### Tables to replicate

| Postgres Table       | Key Columns                                                                 | Notes                         |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------- |
| `articles`           | `id`, `article_created_at`, `article_updated_at`, `title`, `abstract`, ...  | **Full replication (C.1)**    |
| `projects`           | `id`, `model_id`, `date_from`, `date_to`, `use_*`, `archived`               | Small, replicate fully        |
| `project_prompts`    | `project_id`, `prompt_id`, `enabled`                                        | Small, replicate fully        |
| `judgments`          | `article_id`, `prompt_id`, `model_id`, `is_answered`, `deleted_at`, `use_*` | Main assessment table         |
| `project_articles`   | `project_id`, `article_id`                                                  | Direct scope link             |
| `project_route_link` | `project_id`, `import_route_id`                                             | Note: FK is `import_route_id` |
| `article_route_link` | `article_id`, `import_route_id`                                             | Note: FK is `import_route_id` |
| `import_route`       | `id`, `route`                                                               | Replicate (legacy path kept)  |

---

## Infrastructure setup

### 1) PostgreSQL: enable logical replication

> ⚠️ **CRITICAL**: Two key configuration changes required for Docker environments:
>
> 1. `listen_addresses = '*'` in postgresql.conf (default 'localhost' blocks container-to-container connections)
> 2. `SUPERUSER` privilege for ch_replicator (MaterializedPostgreSQL requires it for publication management)

```ini
# postgresql.conf
# Enable logical replication for MaterializedPostgreSQL
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10

# CRITICAL for Docker: Allow connections from other containers
listen_addresses = '*'
```

Create replication user with default privileges (so new tables don't break replication):

```sql
-- SUPERUSER required for MaterializedPostgreSQL to manage publications and replication slots
CREATE USER ch_replicator WITH REPLICATION SUPERUSER PASSWORD 'xxx';

-- Grant on existing tables (technically redundant with SUPERUSER, but explicit is better)
GRANT USAGE ON SCHEMA public TO ch_replicator;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ch_replicator;

-- Grant on future tables (critical: prevents breaks when new tables are created)
-- Run both commands: one for current role, one for migration role
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ch_replicator;
ALTER DEFAULT PRIVILEGES FOR ROLE forska_admin IN SCHEMA public GRANT SELECT ON TABLES TO ch_replicator;

-- Verify grants were applied:
SELECT * FROM information_schema.role_table_grants WHERE grantee = 'ch_replicator';
-- Should show SELECT grants on all existing tables

-- Verify default privileges are set:
SELECT
  defaclrole::regrole AS grantor,
  defaclobjtype AS object_type,
  defaclacl AS privileges
FROM pg_default_acl
WHERE 'ch_replicator' = ANY(aclexplode(defaclacl)).grantee::text;
-- Should show entries for both current role and forska_admin

-- Check for other roles that might create tables:
SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public';
-- If other roles exist, run: ALTER DEFAULT PRIVILEGES FOR ROLE <other_role> IN SCHEMA public GRANT SELECT ON TABLES TO ch_replicator;
```

> ⚠️ **`ALTER DEFAULT PRIVILEGES` ownership caveat**: This only applies to tables created by the _current role_ (or the role specified via `FOR ROLE`). If database migrations run as a different user (e.g., `forska_admin`), new tables they create will NOT inherit grants to `ch_replicator`. The commands above handle both the current role and `forska_admin`. If you discover other roles creating tables (via the `tableowner` query above), add `ALTER DEFAULT PRIVILEGES FOR ROLE` for those roles too.
> **Publication/Replication Slot**: MaterializedPostgreSQL creates its own publication and replication slot automatically. However, some setups may require explicit creation:
>
> ```sql
> -- If CH requires explicit publication (check CH version docs):
> CREATE PUBLICATION forska_ch_pub FOR TABLE projects, project_prompts, judgments, project_articles, project_route_link, article_route_link, import_route;
>
> -- Replication slot is typically created by CH, but verify slot exists:
> SELECT * FROM pg_replication_slots WHERE slot_name LIKE '%ch%';
> ```

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
) SETTINGS materialized_postgresql_tables_list = 'articles,projects,project_prompts,judgments,project_articles,project_route_link,article_route_link,import_route';
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

> ⚠️ **Query pattern note**: Prefer `NOT EXISTS` over `NOT IN` to avoid NULL semantics issues. `NOT IN (subquery)` returns unknown/false if subquery contains NULL, which can silently drop results. `NOT EXISTS` is NULL-safe.

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
    SELECT prompt_id FROM pg.project_prompts WHERE project_id = 'X' AND enabled = true AND archived = false
  ),
  assessed AS (
    SELECT j.article_id
    FROM pg.judgments j
    JOIN pg.projects p ON p.id = 'X'
    WHERE j.article_id IN (SELECT article_id FROM scoped)  -- Critical: only scan scoped articles
      AND j.deleted_at IS NULL
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
       ELSE (
         SELECT COUNT(*) FROM scoped s
         WHERE NOT EXISTS (
           SELECT 1 FROM assessed a WHERE a.article_id = s.article_id
         )
       )
  END AS unassessed_count;"
```

---

## ClickHouse query building blocks

> ⚠️ **Not SQL functions**: ClickHouse doesn't support parameterized SQL functions like `scoped_article_ids(projectId)`. These are **query templates** or **CTEs** that must be inlined with `WHERE project_id = ?`. They can also be implemented as views over all `(project_id, article_id)` pairs, filtered at query time.

Create in `forska_helpers` DB (not `pg.*`):

| Query Template               | Returns               | Notes                                                                               |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `scoped_article_ids` CTE     | `DISTINCT article_id` | 2-way union (direct + route-based), filter by `project_id = ?`                      |
| `enabled_prompt_ids` CTE     | `DISTINCT prompt_id`  | From `project_prompts WHERE project_id = ? AND enabled = true AND archived = false` |
| `assessed_article_ids` CTE   | `DISTINCT article_id` | Articles with ALL enabled prompts judged                                            |
| `unassessed_article_ids` CTE | `DISTINCT article_id` | `scoped - assessed` (guard for 0 prompts)                                           |

Alternatively, create parameterizable **views** over all projects:

```sql
-- View: all scoped (project_id, article_id) pairs
CREATE VIEW forska_helpers.scoped_articles AS
SELECT project_id, article_id FROM pg.project_articles
UNION DISTINCT
SELECT prl.project_id, arl.article_id
FROM pg.project_route_link prl
JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id;

-- Usage: SELECT article_id FROM forska_helpers.scoped_articles WHERE project_id = ?
```

---

## Feature implementations

### 1) Jobs page: unassessed count

**Current**: Heavy Postgres query with cross join + NOT EXISTS.

**CH strategy**:

1. Keep job context fetch in Postgres (`jobId → projectId`) — fast, single row
2. Compute in CH: `unassessed_count = scoped_count - fully_assessed_count`
3. Guard: return 0 if 0 enabled prompts
4. Keep existing 10s cache (can relax after perf confirmation)

### 2) Jobs page: unassessed articles list

**CH strategy**:

1. Query `unassessed_article_ids(projectId)` with keyset pagination
2. Order by `article_updated_at DESC` (canonical sort column)
3. Use keyset cursor: `WHERE (article_updated_at, article_id) < (?, ?) ORDER BY article_updated_at DESC, article_id DESC LIMIT 100`
4. Return IDs from CH, hydrate from Postgres via `WHERE id IN (...)` (limit 100)

> ⚠️ **Index for pagination**: Ensure CH has an index on `(article_updated_at, article_id)` for efficient keyset pagination. MaterializedPostgreSQL may auto-create indexes based on PG indexes. Verify with `SHOW CREATE TABLE pg.articles;` and create manually if needed.

### 3) Project Reviews Unassessed page

**Endpoint**: `/api/articlesreviewsunassessed`

**CH strategy**:

1. CH query for count + paginated article IDs
2. **Use keyset pagination** (prevents duplicates/skips during concurrent updates):
   ```sql
   WHERE (article_updated_at, article_id) < (?, ?)
   ORDER BY article_updated_at DESC, article_id DESC
   LIMIT 100
   ```
   > ⚠️ **Why keyset over offset**: If articles update between page requests, offset pagination can skip/duplicate rows. Keyset pagination uses cursor position (last seen timestamp + id) to maintain consistency.

### 4) Cron: `judgmentsJobsCronGetPrompts`

**Goal**: Avoid Postgres cross join + NOT EXISTS scans.

**CH strategy**:

> ⚠️ **0 enabled prompts guard**: Add app-level check BEFORE running CH query. If 0 prompts, return early `{promptEntries: []}` to avoid unnecessary CROSS JOIN:
>
> ```ts
> const enabledPromptsCount = await getEnabledPromptsCount(projectId)
> if (enabledPromptsCount === 0) return {promptEntries: []}
> ```

**CH query** (run only if prompts exist):

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
    SELECT prompt_id FROM pg.project_prompts WHERE project_id = ? AND enabled = true AND archived = false
  ),
  -- assessed returns (article_id, prompt_id) pairs, not just article_id
  assessed_pairs AS (
    SELECT j.article_id, j.prompt_id
    FROM pg.judgments j
    JOIN pg.projects p ON p.id = ?
    WHERE j.article_id IN (SELECT article_id FROM scoped)  -- Critical: only scan scoped articles
      AND j.deleted_at IS NULL
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
await db.insert(judgmentsJobsPrompts).values(pairs).onConflictDoNothing()
```

> ⚠️ **Replication lag caveat**: CH may return pairs that were _just_ judged in Postgres.
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

**Option B (check MaterializedPostgreSQL database status)**:

```sql
-- Check if MaterializedPostgreSQL engine is running
SELECT
  name,
  engine,
  data_path,
  metadata_path
FROM system.databases
WHERE name = 'pg' AND engine LIKE '%MaterializedPostgreSQL%';

-- Check table sync status (row counts as proxy)
SELECT
  database,
  table,
  total_rows
FROM system.tables
WHERE database = 'pg';
```

**Option C (compare row counts for lag detection)**:

```sql
-- Compare PG vs CH counts as proxy for lag
-- Run periodically and alert if delta persists > 60s
```

Add to runtime logging:

```ts
// Verify query works in your CH version before using
const lagQuery = `SELECT max(total_lag_seconds) as lag FROM system.postgres_replication_slots WHERE database = 'pg'`
const lag = await clickhouse.query(lagQuery).catch(() => null)
if (lag) logger.info({chReplicationLagSec: lag}, 'CH replication status')
```

**Alert thresholds**:

- ⚠️ Warning: lag > 10s
- 🚨 Critical: lag > 60s → investigate CH health

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

| Risk                           | Impact                                            | Mitigation                                                                                                  |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Assessed semantics drift**   | CH/PG counts differ                               | Unify PG queries first (`is_answered`, `deleted_at`, `enabled`)                                             |
| **Assessed CTE performance**   | Scanning all judgments instead of scoped only     | Add `j.article_id IN (SELECT article_id FROM scoped)` filter                                                |
| **0 enabled prompts**          | CH returns all articles as unassessed             | Add guard clause in queries (return 0 or early exit)                                                        |
| **Full articles replication**  | Storage/WAL bloat                                 | Monitor disk usage; articles replicated in controlled manner                                                |
| **Views in MaterializedPG DB** | May fail or behave unexpectedly                   | Use separate `forska_helpers` DB                                                                            |
| **Monitoring query**           | `system.postgres_replication_slots` may not exist | Test in target CH version; fallback to row count comparison                                                 |
| **Replication lag**            | Stale counts, missed articles                     | Accept 1-5s lag expected for MaterializedPostgreSQL                                                         |
| **WAL growth**                 | Disk full on Postgres                             | Monitor slot size; alert on > 1GB; emergency slot drop procedure                                            |
| **Type mapping**               | UUID/timestamp params from app                    | MaterializedPostgreSQL auto-converts PG types; if manual casts needed: `toUUID('...')`, `toDateTime('...')` |

---

## Pre-flight checklist (before implementing CH)

- [x] **Unify PG "assessed" semantics**: Update `JudgmentsJobsRoutes.ts` and `projectsRoutesGetArticlesReviewsUnassessed.ts` to filter `is_answered = true`, `deleted_at IS NULL`, and `project_prompts.enabled = true`
- [ ] **Backfill `article_route_link` if needed**: Required if you want to deprecate Path 3 string-matching or if many articles lack FK entries. Skip if Path 3 performance is acceptable:
  ```sql
  INSERT INTO article_route_link (article_id, import_route_id)
  SELECT a.id, ir.id
  FROM articles a
  JOIN import_route ir ON ir.route = a.import_route
  WHERE a.import_route IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM article_route_link arl WHERE arl.article_id = a.id)
  ON CONFLICT DO NOTHING;
  ```
- [ ] **Verify CH version**: Check if `system.postgres_replication_slots` exists with expected columns

---

## Rollout plan

### Phase 1: PG cleanup

- [x] Unify assessed semantics in all PG queries (add `is_answered`, `deleted_at`, `enabled`, `archived` filters)
- [ ] Backfill `article_route_link` if needed (see pre-flight checklist for SQL; only needed if deprecating Path 3 or articles missing FK entries)

### Phase 2: Infrastructure

- [x] Enable logical replication in Postgres (`wal_level = logical`)
- [x] Fix PostgreSQL network config: Added `listen_addresses = '*'` to `config/postgres/postgresql.conf` (required for Docker container-to-container communication)
- [x] Create CH replication user with appropriate grants (including `FOR ROLE` if migrations run as different user)
  - **Note**: Granted SUPERUSER to `ch_replicator` (required by MaterializedPostgreSQL engine for publication management)
- [x] Verify CH version supports MaterializedPostgreSQL with expected features
- [x] Create `pg` database in ClickHouse with full `articles` table (C.1 approach):
  ```sql
  CREATE DATABASE pg ENGINE = MaterializedPostgreSQL(
    'db:5432', 'postgres', 'ch_replicator', '<password>'
  ) SETTINGS materialized_postgresql_tables_list =
    'articles,projects,project_prompts,judgments,project_articles,project_route_link,article_route_link,import_route';
  ```
  **Note**: Uses Docker service name `db:5432` for container-to-container communication
- [x] Create `forska_helpers` database for views/CTEs
- [x] Enable experimental MaterializedPostgreSQL engine via `config/clickhouse/experimental-users.xml`
- [x] **Wait for initial sync to complete** - All 8 tables synced (~35M rows, 237 GiB total, completed 2026-01-16)
- [x] Create helper view `forska_helpers.scoped_articles`
- [x] Confirm monitoring query works in CH version (adapted for ClickHouse SQL syntax - see `config/clickhouse/CLICKHOUSE_QUERY_SYNTAX.md`)
- [x] **✅ RESOLVED: Articles table mismatch fixed (2026-01-16)**
  - **Root cause**: MaterializedPostgreSQL bug with large table initial snapshots (incomplete syncs)
  - **Solution**: Created `forska.articles` MergeTree table, synced via `postgresql()` function
  - **Result**: 100% row count match (10,526,004 rows)
  - **Details**: See `config/clickhouse/INVESTIGATE_ARTICLE_MISMATCH.md`
- [x] ~~Verify index on `pg.articles (article_updated_at, article_id)` exists~~ (N/A - MaterializedPostgreSQL does not replicate indexes; uses `ORDER BY tuple(id)` instead)
- [x] **Monitor CH disk usage** after initial sync: 237 GiB (compressed columnar format)
- [x] Use PeerDB CDC for ongoing PG→CH sync
- [x] Update `forska_helpers.scoped_articles` view to use `forska.articles`

**Phase 2 Status**: ✅ COMPLETE

**Critical Fixes Applied**:

1. PostgreSQL `listen_addresses = '*'` (was `localhost`, blocked CH connections)
2. Granted SUPERUSER to ch_replicator (MaterializedPostgreSQL requirement)
3. **Articles replication workaround**: MaterializedPostgreSQL has a bug with large tables. Created `forska.articles` (MergeTree) synced via batch INSERT from `postgresql()` function instead of relying on `pg.articles`.

**Articles Table Architecture**:

- `pg.articles` - MaterializedPostgreSQL replica (incomplete, ~64% of rows, DO NOT USE)
- `forska.articles` - MergeTree table with ReplacingMergeTree(updated_at), 100% synced
- Excluded columns: `article_authors`, `original_data`, `full_text_assets` (null byte issues)
- Sync: PeerDB CDC (no scripts)

**Documentation Created**:

- `config/clickhouse/STATUS.md` - Current status and quick reference
- `config/clickhouse/SETUP_PROGRESS.md` - Step-by-step setup log
- `config/clickhouse/TROUBLESHOOTING.md` - Common issues and solutions
- `config/clickhouse/CLICKHOUSE_QUERY_SYNTAX.md` - SQL syntax differences (NOT EXISTS → LEFT JOIN, JOIN ON constant → CROSS JOIN)
- `config/clickhouse/INVESTIGATE_ARTICLE_MISMATCH.md` - Investigation and resolution details

### Phase 3: Deploy

**Status**: 🚧 IN PROGRESS

- [x] Implement CH queries for:
  - [x] Jobs page: unassessed count (`getUnassessedCountFromClickHouse`)
  - [x] Reviews/unassessed page: paginated list (`getUnassessedArticlesFromClickHouse`)
  - [x] Cron queue fill: (article, prompt) pairs (`getUnassessedPairsFromClickHouse`)
- [x] Add 0-prompt guard to all queries (returns 0/empty if no enabled prompts)
- [ ] Deploy to staging; verify counts match PG
- [ ] Deploy to production
- [ ] Observe query latency + CH disk usage

**Implementation Notes**:

- Created `src/services/clickhouse/unassessedArticlesClickHouse.ts` with 3 CH query functions
- Updated `JudgmentsJobsRoutes.ts` to use CH for `/api/judgmentsjobs-unassessed-count`
- Updated `projectsRoutesGetArticlesReviewsUnassessed.ts` to use CH for `/api/articlesreviewsunassessed`
- Updated `judgmentsJobsCronGetPrompts.ts` to use CH for cron queue fill
- Added `onConflictDoNothing` to queue insert (CH can't check `judgments_jobs_prompts` table)
- CH queries use `pg.*` tables (MaterializedPostgreSQL) + `forska.articles` (MergeTree workaround)

### Phase 4: Evaluate

- [ ] Compare CH vs PG counts for sample projects
- [ ] Verify pagination consistency (no page-boundary issues)
- [ ] Monitor WAL slot size on PG side
- [ ] If noticeable improvement → done
- [ ] If storage becomes a concern → consider switching to C.2 (metadata-only)
- [ ] If other issues → revert commit, reassess approach

---

## Remaining Tasks (Post-Resolution)

### High Priority

- [ ] Ensure PeerDB mirror health + lag alerts
- [ ] **Clean up incomplete `pg` database** (optional - uses 237 GiB disk)
  ```sql
  -- In ClickHouse (requires max_table_size_to_drop=0)
  SET max_table_size_to_drop = 0;
  DROP DATABASE pg;
  -- Then recreate without articles table if needed for other tables
  ```

### Medium Priority

- [ ] **Monitor memory usage on `scoped_articles` view** - Currently hits memory limit on large queries
- [ ] **Add missing columns to `forska.articles`** if needed:
  - `article_authors` (Array - excluded due to null byte issues)
  - `original_data` (JSON)
  - `full_text_assets` (JSON)

### Low Priority

- [ ] Consider upgrading ClickHouse to fix MaterializedPostgreSQL bug
- [ ] Evaluate if `pg.articles` can be dropped entirely (other tables in `pg.*` still useful)
