# ARTICLE_IN_CH — MaterializedPostgreSQL plan

Goal: ClickHouse has *exact* project-scope articles + judgments state, continuously from Postgres, to power:
- Jobs page: Unassessed Articles count (`/api/judgmentsjobs-unassessed-count`)
- Project Reviews Unassessed page: list+count (`/api/articlesreviewsunassessed`)
- Cron queue fill: ready (article×prompt) pairs (`src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`)

```
┌─────────────┐      WAL Stream       ┌─────────────────────────────┐
│  PostgreSQL │ ───────────────────▶  │  ClickHouse                 │
│             │   (logical repl)      │  MaterializedPostgreSQL DB  │
│  - projects │                       │  (pg.*)                     │
│  - articles │   Replication Slot    │                             │
│  - judgments│ ◀─ tracks position ─▶ │  Near real-time replica     │
│  - scopes   │                       │  (expect 1-5s lag)          │
└─────────────┘                       └─────────────────────────────┘
```

---

## Definitions (canonical semantics)

### Project scope articles
Articles in scope for a project are defined as:
```sql
(SELECT article_id FROM project_articles WHERE project_id = ?)
UNION
(SELECT arl.article_id
 FROM project_route_link prl
 JOIN article_route_link arl ON arl.route_id = prl.route_id
 WHERE prl.project_id = ?)
```

### "Assessed" judgment
A judgment row in `judgments` qualifies as "assessed" if **all** of these are true:
- `deleted_at IS NULL`
- `is_answered = true` ← **Decision: unify this across jobs routes and cron**
- Content settings match project: `(model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)` = project values
- `prompt_id` ∈ enabled `project_prompts` (where `enabled = true`)

> ⚠️ **Current inconsistency**: Jobs routes ignore `is_answered`; cron requires `true`.
> **Resolution**: Enforce `is_answered = true` everywhere for consistency.

### "Unassessed" article
An article is "unassessed" if it is missing ≥1 assessed judgment for any enabled prompt.

---

## Tables to replicate in ClickHouse

| Postgres Table         | Key Columns                                                         | Notes                          |
|------------------------|---------------------------------------------------------------------|--------------------------------|
| `projects`             | `id`, `model_id`, `date_from`, `date_to`, `use_title`, `use_abstract`, `use_fulltext`, `use_fulltext_no_images`, `archived` | Content flags explicit |
| `project_prompts`      | `project_id`, `prompt_id`, `enabled`                                | Small table, fast to replicate |
| `articles`             | `id`, `title`, `authors`, `article_created_at`, `article_updated_at` | Sort by `article_updated_at` for lists |
| `judgments`            | `article_id`, `prompt_id`, `model_id`, `is_answered`, `deleted_at`, `use_title`, `use_abstract`, `use_fulltext`, `use_fulltext_no_images` | Main table for assessment |
| `project_articles`     | `project_id`, `article_id`                                          | Direct scope link              |
| `project_route_link`   | `project_id`, `route_id`                                            | Indirect scope (via routes)    |
| `article_route_link`   | `article_id`, `route_id`                                            | Indirect scope (via routes)    |
| `judgments_jobs`       | `id`, `project_id`, `status`, ...                                   | Optional: for job context      |
| `judgments_jobs_prompts` | `job_id`, `article_id`, `prompt_id`, `status`                     | Optional: queue state          |

---

## Infrastructure setup

### 1) PostgreSQL: enable logical replication
```ini
# postgresql.conf
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
```

Create replication user:
```sql
CREATE USER ch_replicator WITH REPLICATION PASSWORD 'xxx';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ch_replicator;
```

> ⚠️ **WAL growth**: If CH consumer lags or goes offline, the replication slot holds WAL.
> Monitor with: `SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots;`

### 2) ClickHouse: create isolated replicated database
```sql
CREATE DATABASE pg ENGINE = MaterializedPostgreSQL(
  'postgres-host:5432',
  'forska_db',
  'ch_replicator',
  'xxx'
) SETTINGS materialized_postgresql_tables_list = 'projects,project_prompts,articles,judgments,project_articles,project_route_link,article_route_link';
```

> 📌 Use a separate DB name (`pg`) to avoid collision with existing `forska.judgments` (Parquet-based).

### 3) Verification queries

**Row count sanity:**
```sql
-- In Postgres
SELECT 'projects' AS tbl, COUNT(*) FROM projects
UNION ALL SELECT 'articles', COUNT(*) FROM articles
UNION ALL SELECT 'judgments', COUNT(*) FROM judgments;

-- In ClickHouse
SELECT 'projects' AS tbl, COUNT(*) FROM pg.projects
UNION ALL SELECT 'articles', COUNT(*) FROM pg.articles
UNION ALL SELECT 'judgments', COUNT(*) FROM pg.judgments;
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
    JOIN pg.article_route_link arl ON arl.route_id = prl.route_id
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
SELECT COUNT(*) AS unassessed_count
FROM scoped s
WHERE s.article_id NOT IN (SELECT article_id FROM assessed);
```

---

## ClickHouse query building blocks

Create these as reusable CTEs or views in `pg.*`:

| Function | Returns | Notes |
|----------|---------|-------|
| `enabled_prompt_ids(projectId)` | `Array(UUID)` or subquery | From `project_prompts WHERE enabled = true` |
| `scoped_article_ids(projectId)` | `DISTINCT article_id` | Union of direct + route-based scope |
| `assessed_article_ids(projectId)` | `DISTINCT article_id` | Articles with ALL enabled prompts judged |
| `unassessed_article_ids(projectId)` | `DISTINCT article_id` | `scoped - assessed` |

---

## Feature implementations

> 🏳️ All features gated behind `USE_CLICKHOUSE_MATERIALIZED_PG` flag.
> On CH error/unavailable → fall back to current Postgres queries.

### 1) Jobs page: unassessed count
**Current**: Heavy Postgres query with cross join + NOT EXISTS.

**CH strategy**:
1. Keep job context fetch in Postgres (`jobId → projectId`) — fast, single row
2. Compute in CH: `unassessed_count = scoped_count - fully_assessed_count`
3. Keep existing 10s cache (can relax after perf confirmation)

### 2) Jobs page: unassessed articles list
**CH strategy**:
1. Query `unassessed_article_ids(projectId)` with pagination
2. Order by `articles.article_updated_at DESC` (canonical sort column)
3. **Option A**: Join `pg.articles` in CH, return full rows
4. **Option B**: Return IDs from CH, hydrate from Postgres via `WHERE id IN (...)` (limit 100)

> 💡 Option B preferred if article row has fields not replicated to CH (e.g., blob content).

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
1. Query: emit `(article_id, prompt_id)` pairs that are missing, ordered by newest articles
   ```sql
   SELECT s.article_id, ep.prompt_id
   FROM scoped_articles s
   CROSS JOIN enabled_prompts ep
   LEFT JOIN assessed_judgments j
     ON j.article_id = s.article_id AND j.prompt_id = ep.prompt_id
   WHERE j.article_id IS NULL
   ORDER BY (SELECT article_updated_at FROM pg.articles WHERE id = s.article_id) DESC
   LIMIT 1000
   ```
2. Insert to `judgments_jobs_prompts` with conflict handling

**Database constraint** (create via Drizzle CLI):
```ts
// In schema
judgmentsJobsPrompts: pgTable('judgments_jobs_prompts', {
  // ... existing columns
}, (t) => ({
  uniqueJobArticlePrompt: unique().on(t.jobId, t.articleId, t.promptId),
}));
```

Insert with:
```ts
await db.insert(judgmentsJobsPrompts)
  .values(pairs)
  .onConflictDoNothing();
```

> ⚠️ **Replication lag caveat**: CH may return pairs that were *just* judged in Postgres.
> The `onConflictDoNothing` prevents duplicates, but we might insert "stale" pairs.
> **Mitigation**: Downstream judgment worker checks if already exists before processing (no-op if judged).

---

## Monitoring & alerting

### Replication lag
```sql
-- ClickHouse: check lag per table
SELECT database, table, total_lag_ms
FROM system.postgres_replication_slots;
```

Add to runtime logging:
```ts
const lag = await clickhouse.query(`SELECT max(total_lag_ms) FROM system.postgres_replication_slots`);
logger.info({ chReplicationLagMs: lag }, 'CH replication status');
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
| **Replication lag** | Stale counts, missed articles | Accept 1-5s lag; fallback to Postgres for user-facing actions |
| **WAL growth** | Disk full on Postgres | Monitor slot size; alert on > 1GB; emergency slot drop procedure |
| **Type mapping** | UUID/timestamp mismatches → silent failures | Explicit casts in CH queries; verify with test data |
| **Soft delete timing** | `deleted_at` lags → under-count unassessed | Acceptable if lag < 10s; document expected behavior |
| **Scope changes** | New route links lag behind | User sees stale scope for a few seconds; fallback if critical |
| **`project_prompts` toggle** | Cron uses stale enabled list | Fetch `project_prompts` from Postgres (small table) OR accept brief lag |
| **Concurrent jobs** | Unique constraint collision | `onConflictDoNothing` handles gracefully |
| **CH unavailable** | Feature broken | Circuit breaker fallback to Postgres |

---

## Rollout plan

### Phase 1: Infrastructure
- [ ] Enable logical replication in Postgres
- [ ] Create CH replication user with appropriate grants
- [ ] Create `pg` database in ClickHouse with table list
- [ ] Verify row counts match between PG and CH
- [ ] Set up monitoring for replication lag

### Phase 2: Deploy
- [ ] Implement CH queries (replaces Postgres queries directly)
- [ ] Deploy to production
- [ ] Observe query latency

### Phase 3: Evaluate
- [ ] If noticeable improvement → done
- [ ] If no improvement or issues → revert commit, reassess approach
