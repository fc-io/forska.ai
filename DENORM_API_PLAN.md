# Denormalized API Optimization Plan

> **Goal**: Optimize `/api/articlesreviews` and `/api/articlesreviewsfilters` to use denormalized fields on the `judgments` table, eliminating expensive JOINs and EXISTS subqueries.

## Background

The `judgments` table has been denormalized with the following fields that APIs can now leverage:

| Field | Purpose |
|-------|---------|
| `promptId` | Primary query anchor - immutable, used to find judgments for a project's prompts |
| `articleTitle` | Eliminates JOIN to `articles` for display |
| `articleCreatedAt` | Eliminates JOIN to `articles` for date filtering |
| `articleUpdatedAt` | Eliminates JOIN to `articles` for date filtering |
| `articleImportRoute` | Eliminates EXISTS on `article_route_link` - immutable |
| `projectId` | Indicates originating project (informational only - judgments can be shared) |

**Key Constraint**: `projectId` indicates where a judgment was *created*, but judgments/articles can be shared across projects. Use `articleImportRoute` and `project_articles` for scope determination.

---

## Current Flow (Slow)

```
1. Get project's enabled prompts → promptIds[]
2. Get project's date bounds
3. Get project's import routes → routeIdArray (UUIDs)
4. Build scope condition:
   - EXISTS (SELECT 1 FROM article_route_link WHERE article_id = articles.id AND import_route_id = ANY(...))
   - OR EXISTS (SELECT 1 FROM project_articles WHERE article_id = articles.id AND project_id = ...)
5. Query: articles JOIN judgments WHERE <scope> GROUP BY article HAVING all prompts answered
6. Paginate and fetch judgments for matched articles
```

**Problems**:
- Two EXISTS subqueries evaluated per article row
- JOIN to `articles` table for title and date filtering
- UUID-based import route matching through link table

---

## Optimized Flow

### Step 1: Parallel Metadata Queries

Execute these in parallel:

```sql
-- 1a. Get enabled prompts for project
SELECT prompts.id, project_prompts.order
FROM project_prompts
JOIN prompts ON prompts.id = project_prompts.prompt_id
WHERE project_prompts.project_id = $projectId
  AND project_prompts.enabled = true
ORDER BY project_prompts.order

-- 1b. Get project date bounds
SELECT date_from, date_to
FROM projects
WHERE id = $projectId

-- 1c. Get import routes as TEXT (not UUID!)
SELECT ir.route
FROM project_route_link prl
JOIN import_route ir ON ir.id = prl.import_route_id
WHERE prl.project_id = $projectId

-- NOTE: Do NOT pre-fetch curated article IDs here!
-- Projects can have many curated articles. Use a subquery instead (see Step 2).
```

### Step 2: Query Judgments Directly

**No JOIN to `articles` needed!** Use denormalized fields:

```sql
SELECT
  j.article_id,
  j.article_title,              -- denormalized
  j.article_created_at,         -- denormalized
  j.prompt_id,
  j.answered_original,
  j.answered_original_as_array,
  j.explanation,
  j.quotes
FROM judgments j
WHERE j.prompt_id = ANY($promptIds)
  AND j.deleted_at IS NULL
  AND (
    j.article_import_route = ANY($routeTexts)   -- Import route match (TEXT comparison)
    OR j.article_id IN (                         -- Curated articles (subquery, not pre-fetched)
        SELECT article_id FROM project_articles WHERE project_id = $projectId
    )
  )
  -- Project date bounds
  AND ($dateFrom IS NULL OR j.article_created_at >= $dateFrom)
  AND ($dateTo IS NULL OR j.article_created_at <= $dateTo)
  -- UI filters
  AND ($uiFromDate IS NULL OR j.article_created_at >= $uiFromDate)
  AND ($uiToDate IS NULL OR j.article_created_at <= $uiToDate)
  AND ($search IS NULL OR j.article_title ILIKE '%' || $search || '%')
```

### Step 3: Group and Filter for Complete Judgments

```sql
WITH matching_judgments AS (
  -- Step 2 query
)
SELECT
  article_id,
  MAX(article_title) AS article_title,
  MAX(article_created_at) AS article_created_at
FROM matching_judgments
GROUP BY article_id
HAVING COUNT(DISTINCT prompt_id) = $promptCount  -- All prompts answered
ORDER BY MAX(article_created_at) DESC
```

### Step 4: Paginate and Fetch Full Judgments

```sql
-- Get page of article IDs
WITH complete_articles AS (
  -- Step 3 query with LIMIT/OFFSET
)
SELECT j.*
FROM judgments j
WHERE j.article_id = ANY(SELECT article_id FROM complete_articles)
  AND j.prompt_id = ANY($promptIds)
  AND j.deleted_at IS NULL
```

---

## Performance Comparison

| Aspect | Before | After |
|--------|--------|-------|
| Tables in main query | `articles`, `judgments`, `project_articles`, `article_route_link` | `judgments` only |
| EXISTS subqueries | 2 per row | 0 |
| JOIN to articles | Required | Not needed |
| Import route check | UUID EXISTS on link table | TEXT = ANY() on denormalized field |
| Curated articles check | Double EXISTS in OR | Simple subquery (query planner optimizes) |

---

## Required Indexes

Add these indexes for optimal performance:

```sql
-- Primary query pattern: filter by prompt, route, date
CREATE INDEX CONCURRENTLY judgments_prompt_route_created_idx
ON judgments(prompt_id, article_import_route, article_created_at)
WHERE deleted_at IS NULL;

-- Alternative: if searching by title frequently
CREATE INDEX CONCURRENTLY judgments_prompt_created_title_idx
ON judgments(prompt_id, article_created_at)
INCLUDE (article_title, article_import_route, article_id)
WHERE deleted_at IS NULL;
```

---

## Implementation Checklist

### Phase 1: `/api/articlesreviews` Optimization

- [x] Refactor metadata queries to run in parallel (prompts, bounds, routes)
- [x] Replace `articles JOIN judgments` with direct `judgments` query using denormalized fields
- [x] Replace EXISTS subqueries with:
  - `article_import_route = ANY($routeTexts)` for import route matching
  - `article_id IN (SELECT ... FROM project_articles)` subquery for curated articles
- [x] Use `article_created_at` and `article_title` from judgments (no JOIN)
- [x] Add new indexes (`0046_illegal_la_nuit.sql` migration applied)
- [ ] Test with large projects to verify performance improvement

### Phase 2: `/api/articlesreviewsfilters` Optimization

- [ ] Apply same pattern for filter discovery queries
- [ ] Remove JOIN to articles table
- [ ] Use denormalized `article_import_route` for scope filtering

### Phase 2.5: Async Count Endpoint (Completed)

The count query (`COUNT(*)` over grouped articles) was taking ~60s and blocking initial data load. This was extracted to a separate endpoint.

**Changes made:**

1. **New endpoint: `POST /api/articlesreviewscount`**
   - Returns `{ totalCount, totalPages }`
   - Same request body as `/api/articlesreviews` (minus `page`)
   - Cached for 5 minutes on the frontend (expensive to compute)

2. **Shared query builder: `articlesReviewsQueryBuilder.ts`**
   - `fetchProjectMetadata()` - Parallel fetch of prompts, bounds, import routes
   - `buildArticlesReviewsQueryContext()` - Builds WHERE/HAVING conditions
   - Used by both `/api/articlesreviews` and `/api/articlesreviewscount`

3. **Updated main endpoint: `/api/articlesreviews`**
   - Now returns `totalCount: null, totalPages: null`
   - Data loads immediately without waiting for count

4. **Frontend changes:**
   - `projectsArticlesReviewsCountQuery.ts` - Separate count query hook
   - `reviewsArticlesTableContainer.tsx` - Fetches data and count in parallel
   - `reviewsPaginationControls.tsx` - Handles `null` totalPages gracefully
   - Shows "Counting..." animation while count loads

**User experience:**
- Data table loads immediately (fast perceived load)
- "Counting..." shows in header and pagination
- Count updates asynchronously when ready

### Phase 2.6: Two-Phase Fetch & HAVING Simplification (Completed)

The Phase 1 GROUP BY query was still slow (~49s) due to:
1. Single query with subquery join causing PostgreSQL to potentially scan the entire judgments table twice
2. `COUNT(DISTINCT prompt_id) = N` HAVING clause requiring expensive aggregation over all rows

**Changes made:**

1. **Two-Phase Fetch Pattern**
   - [x] Phase 1: Get article IDs only (GROUP BY + pagination)
   - [x] Phase 2: Fetch judgments with literal UUIDs (`WHERE article_id IN (uuid1, uuid2, ...)`)
   - [x] Guarantees PostgreSQL uses Index Scan (O(L×J×P)) instead of Seq Scan (O(N))

2. **Removed `COUNT(DISTINCT prompt_id) = N` from HAVING**
   - [x] No longer filter to "only fully-judged articles"
   - [x] HAVING is now only applied when answer filters exist (otherwise `HAVING 1=1`)
   - [x] Dramatically simplifies the aggregation work

3. **Added judged status to response**
   - [x] `judgedPromptIds: string[]` — which prompts have been judged for each article
   - [x] `isFullyJudged: boolean` — true if all project prompts have judgments

4. **Removed `deleted_at IS NULL` filter**
   - [x] Soft deletes not currently used, removing filter simplifies query

5. **Frontend updates**
   - [x] Added "Status" column showing "Complete" (green) or "Partial" (yellow)
   - [x] Updated header: "Articles with Judgments" (was "Articles with Complete Judgments")
   - [x] Updated description to reflect partial judgments are now shown

**Big O Analysis:**

| Query Part | Before | After |
|------------|--------|-------|
| Phase 1 (article IDs) | O(N) with `COUNT(DISTINCT)` + sort | O(N) with simple hash aggregate |
| Phase 2 (fetch judgments) | O(N) or O(L×J×P) (subquery join) | O(L×J×P) guaranteed (literal UUIDs) |

Where: N = total matching rows, L = limit (100), J = judgments per article, P = prompts

### Phase 2.7: PostgreSQL Optimization Conclusion (2024-12-19)

After extensive investigation, we've concluded that **PostgreSQL cannot make this query fast** for our use case. This section documents what was tried so that future developers don't repeat the same investigations.

#### The Core Problem

The query requires:
1. **Filter** by cross-prompt answer conditions (HAVING clause)
2. **Sort** by `article_created_at DESC`
3. **Paginate** with LIMIT/OFFSET

The HAVING clause filters on aggregates across multiple prompts:
```sql
HAVING
  SUM(CASE WHEN prompt_id = 'A' AND answer = 'Yes' THEN 1 ELSE 0 END) > 0
  AND SUM(CASE WHEN prompt_id = 'B' AND answer = 'No' THEN 1 ELSE 0 END) > 0
```

This requires scanning ALL matching judgment rows to compute the aggregates before filtering and sorting.

#### Optimizations Attempted

| Approach | Result | Why It Failed |
|----------|--------|---------------|
| **Two-Phase Fetch** | ✅ Phase 2 fast, ❌ Phase 1 still slow | Phase 1 still requires GROUP BY + aggregate + sort |
| **Remove COUNT(DISTINCT)** | ⚠️ Partial improvement | Still need HAVING for answer filters (always used) |
| **EXISTS on articles table** | ❌ Not applicable | Answer filters require aggregation, EXISTS can't help |
| **Pre-computed stats table** | ❌ Doesn't scale | Cross-prompt answer filters require JSONB + GIN, which doesn't combine well with ORDER BY |
| **Flattened answer table** | ❌ Cross-prompt joins | Filtering multiple prompts requires self-joins, potentially slower |
| **Partial indexes** | ❌ Marginal improvement | Index speeds up row access but doesn't help aggregation |
| **Covering indexes** | ❌ Marginal improvement | Same issue — aggregation is the bottleneck, not row access |

#### Big O Analysis: Why It's Inherently Slow

```
Current complexity: O(M × aggregate × sort)

Where:
- M = rows matching prompt_id filter (~2M for large projects)
- aggregate = hash grouping + CASE/SUM per group
- sort = O(A log A) where A = number of distinct articles (~500K)

Even with perfect indexes, the query must:
1. Scan M rows
2. Group into A buckets
3. Compute aggregates per bucket
4. Filter by HAVING
5. Sort remaining buckets
6. Return top 100

Steps 2-5 cannot be optimized with indexes because they operate on aggregated data.
```

#### Conclusion

**PostgreSQL is not the right tool for this query pattern.**

The answer filters (HAVING on cross-prompt aggregates) combined with ORDER BY + pagination is a fundamental mismatch with PostgreSQL's row-based processing model.

**Recommended solutions:**
1. **ClickHouse** (see CLICK_PLAN.md) — Columnar storage handles aggregations efficiently
2. **Aggressive caching** — Cache query results for common filter combinations
3. **Accept latency** — Show loading spinner for complex queries (~10-50s)

### Phase 3: Validation

- [ ] Compare query plans before/after
- [ ] Benchmark with production-like data
- [ ] Verify result correctness matches old implementation

---

## Edge Cases

1. **Empty import routes**: If project has no linked import routes, `$routeTexts` is empty array. Query relies on curated articles subquery only.

2. **Empty curated articles**: If project has no curated articles, subquery returns nothing. Query relies on `articleImportRoute` only.

3. **Both empty**: Return empty result (no articles in scope).

4. **NULL articleImportRoute**: Curated articles may have NULL import route. They're matched via the `project_articles` subquery.

5. **Large project_articles**: The curated articles check uses a subquery rather than pre-fetching IDs. This allows the query planner to choose optimal execution (hash semi-join, index scan, etc.) regardless of how many curated articles exist.

---

## Notes

- `projectId` on judgments is **informational only** - it indicates where the judgment was created, but judgments can be shared/reused across projects
- Import routes and curated articles are the source of truth for project scope
- Prompts can be shared across projects; `promptId` filter is always combined with scope filter
