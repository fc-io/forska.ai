# PDF Fetch Priority Plan

## Data Model

### Two ways projects get articles:
1. **importRoute**: `project_route_link` → `article_route_link` → `articles`
2. **project_articles**: direct `project_articles` → `articles`

### Projects have:
- `useFulltext` — if true, needs PDFs
- `dateFrom` / `dateTo` — article date range filter

## Algorithm

```
1. Get running jobs: judgments_jobs WHERE status = 'running'

2. Get projects from those jobs, order by useFulltext DESC

3. For each project:
   a. Check if project has project_route_link entries (uses importRoute)
   b. Check if project has project_articles entries (direct link)

   If importRoute:
     SELECT articles.id FROM articles
     JOIN article_route_link ON ...
     JOIN project_route_link ON ...
     WHERE project_route_link.project_id = $project_id
       AND articles.full_text_fetched_at IS NULL
       AND articles.article_created_at BETWEEN dateFrom AND dateTo
     LIMIT batch_size

   If project_articles:
     SELECT articles.id FROM articles
     JOIN project_articles ON ...
     WHERE project_articles.project_id = $project_id
       AND articles.full_text_fetched_at IS NULL
       AND articles.article_created_at BETWEEN dateFrom AND dateTo
     LIMIT batch_size

4. Collect article IDs until we hit numberOfArticlesToFetch limit

5. Fallback: if not enough articles, fetch remaining by created_at DESC
```

## Priority Order
1. Projects w/ running job + `useFulltext=true`
2. Projects w/ running job + `useFulltext=false`
3. Any articles by `created_at DESC` (fallback)

## Why Not Single CTE?
- importRoute vs project_articles require different joins
- Date filtering per-project
- Looping allows early exit once batch filled
- Simpler to debug/optimize per-path

## Indexes Analysis

### importRoute path query:
```sql
FROM articles
JOIN article_route_link ON article_id = articles.id
JOIN project_route_link ON import_route_id = article_route_link.import_route_id
WHERE project_route_link.project_id = ?
  AND articles.full_text_fetched_at IS NULL
  AND articles.article_created_at BETWEEN ? AND ?
```

| Index | Status |
|-------|--------|
| `project_route_link(project_id)` | ✅ exists |
| `article_route_link(import_route_id)` | ✅ exists |
| `articles(article_created_at, ...)` | ✅ exists (`articles_article_created_created_id_idx`) |
| `articles(full_text_fetched_at)` | ⏸ skip for now |

### project_articles path query:
```sql
FROM articles
JOIN project_articles ON article_id = articles.id
WHERE project_articles.project_id = ?
  AND articles.full_text_fetched_at IS NULL
  AND articles.article_created_at BETWEEN ? AND ?
```

| Index | Status |
|-------|--------|
| `project_articles(project_id)` | ✅ exists |
| `project_articles(article_id)` | ✅ exists |
| `articles(article_created_at, ...)` | ✅ exists |
| `articles(full_text_fetched_at)` | ⏸ skip for now |

### Future: Partial Index (if slow)
```sql
CREATE INDEX articles_no_fulltext_idx ON articles(id) WHERE full_text_fetched_at IS NULL;
```
Drizzle: `index(...).on(table.id).where(sql\`full_text_fetched_at IS NULL\`)`

## Checklist

- [x] Rewrite `getArticlesWithoutFullText()` with new algorithm
- [x] Handle importRoute path (project_route_link → article_route_link)
- [x] Handle project_articles path
- [x] Apply dateFrom/dateTo filtering
- [x] Order projects by useFulltext DESC
- [x] Add console.time/timeEnd logs around DB queries
- [x] Add fallback for remaining batch capacity
- [ ] Test with EXPLAIN ANALYZE on both paths
- [ ] Verify cron runs correctly with `RUN_SERVER_FULL_TEXT_FETCHING=true`
