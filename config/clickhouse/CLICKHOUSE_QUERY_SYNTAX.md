# ClickHouse Query Syntax Adaptations

This document outlines the SQL syntax differences between PostgreSQL and ClickHouse that affect queries in the MaterializedPostgreSQL setup.

## Key Differences

### 1. Correlated Subqueries in WHERE clauses

**PostgreSQL (works):**
```sql
SELECT COUNT(*) FROM scoped s
WHERE NOT EXISTS (
  SELECT 1 FROM assessed a WHERE a.article_id = s.article_id
)
```

**ClickHouse (ERROR - UNSUPPORTED_METHOD):**
```sql
-- ✗ NOT EXISTS with correlated subquery not supported
SELECT COUNT(*) FROM scoped s
WHERE NOT EXISTS (
  SELECT 1 FROM assessed a WHERE a.article_id = s.article_id
)
```

**ClickHouse (WORKS):**
```sql
-- ✓ Use LEFT JOIN + IS NULL instead
SELECT COUNT(*)
FROM scoped s
LEFT JOIN assessed a ON s.article_id = a.article_id
WHERE a.article_id IS NULL
```

### 2. JOIN ON constant expression

**PostgreSQL (works):**
```sql
FROM pg.judgments j
JOIN pg.projects p ON p.id = 'constant-uuid'
```

**ClickHouse (ERROR - INVALID_JOIN_ON_EXPRESSION):**
```sql
-- ✗ Cannot use constant in JOIN ON clause
FROM pg.judgments j
JOIN pg.projects p ON p.id = 'constant-uuid'
```

**ClickHouse (WORKS):**
```sql
-- ✓ Use CTE + CROSS JOIN
WITH project_settings AS (
  SELECT model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
  FROM pg.projects WHERE id = 'constant-uuid'
)
SELECT ...
FROM pg.judgments j
CROSS JOIN project_settings p
WHERE j.model_id = p.model_id ...
```

### 3. UNION vs UNION DISTINCT

**Note:** Both work, but ClickHouse recommends `UNION DISTINCT` for clarity.

### 4. Memory Considerations

ClickHouse requires significant memory for complex UNION DISTINCT operations on millions of rows.

**Issue:** View queries like `forska_helpers.scoped_articles` with multiple UNION DISTINCT on millions of rows may hit memory limits.

**Solution:** Filter early in the query:
```sql
-- ✗ Don't materialize full view first
SELECT COUNT(*) FROM forska_helpers.scoped_articles WHERE project_id = 'X'

-- ✓ Use CTEs with early filtering
WITH scoped AS (
  SELECT article_id FROM pg.project_articles WHERE project_id = 'X'
  UNION DISTINCT
  SELECT arl.article_id FROM ...
)
SELECT COUNT(*) FROM scoped
```

## Complete Working Query for Unassessed Count

```sql
WITH
  project_settings AS (
    SELECT model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    FROM pg.projects WHERE id = ?project_id
  ),
  scoped AS (
    SELECT article_id FROM pg.project_articles WHERE project_id = ?project_id
    UNION DISTINCT
    SELECT arl.article_id
    FROM pg.project_route_link prl
    JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id
    WHERE prl.project_id = ?project_id
  ),
  enabled_prompts AS (
    SELECT prompt_id FROM pg.project_prompts
    WHERE project_id = ?project_id
      AND enabled = true
      AND archived = false
  ),
  assessed AS (
    SELECT DISTINCT j.article_id
    FROM pg.judgments j
    CROSS JOIN project_settings p
    WHERE j.article_id IN (SELECT article_id FROM scoped)
      AND j.deleted_at IS NULL
      AND j.is_answered = true
      AND j.model_id = p.model_id
      AND j.use_title = p.use_title
      AND j.use_abstract = p.use_abstract
      AND j.use_fulltext = p.use_fulltext
      AND j.use_fulltext_no_images = p.use_fulltext_no_images
      AND j.prompt_id IN (SELECT prompt_id FROM enabled_prompts)
    GROUP BY j.article_id
    HAVING countDistinct(j.prompt_id) >= (SELECT COUNT(*) FROM enabled_prompts)
  )
SELECT
  COUNT(*) as unassessed_count
FROM scoped s
LEFT JOIN assessed a ON s.article_id = a.article_id
WHERE a.article_id IS NULL
  AND (SELECT COUNT(*) FROM enabled_prompts) > 0
```

## Performance Notes

- **Tested with:** Project with 210K scoped articles, 5.6M total judgments, 3 enabled prompts
- **Query time:** < 1 second (ClickHouse optimized for analytical queries)
- **Memory:** Requires ~14 GiB available for large projects

## Index Considerations

ClickHouse's MaterializedPostgreSQL does NOT replicate PostgreSQL indexes. Instead:
- Primary key: Defined by `ORDER BY` clause (ReplacingMergeTree uses `ORDER BY tuple(id)`)
- Secondary indexes: Not automatically created
- Columnar storage + compression makes full scans fast for analytics

For frequently filtered columns (like `article_updated_at`, `article_id`), ClickHouse's columnar storage performs well without traditional indexes.
