# ClickHouse Verification Report

## 1. Ingestion Verification

- **Target Row Count**: 24,946,050
- **Actual Row Count**: 24,946,050
- **Status**: ✅ COMPLETE

## 2. Schema Verification

- [x] Tables created (`judgments`, `judgments_queue`)
- [x] Materialized View created (`judgments_mv`)
- [x] Keeper configured for S3Queue

## 3. Query Performance Tests

### Query 1: Basic Aggregation (Prompt Counts)

```sql
SELECT promptId, count() FROM forska.judgments GROUP BY promptId
```

- **Execution Time**: ~0.15s (25M rows)

### Query 2: Complex Filtering (The slow Postgres query)

```sql
SELECT
    articleId,
    groupArray((promptId, answeredOriginal)) AS answers
FROM forska.judgments
WHERE deletedAt IS NULL
GROUP BY articleId
HAVING
    sumIf(1, promptId = '07c8dc05-b2c0-46d4-bcfd-42513022d7b6' AND answeredOriginal = 'yes') > 0
    AND sumIf(1, promptId = 'a2d19b1f-20f5-439c-86b2-ea93776bc8fd' AND answeredOriginal = 'yes') > 0
ORDER BY max(articleCreatedAt) DESC
LIMIT 100
```

- **Execution Time**: ~2.5s (Warm cache), ~3.4s (Cold)
- **Comparison**: Postgres (~50s) vs ClickHouse (~2.5s) -> **20x Improvement**

## 4. Data Integrity

- [x] Spot check: Verified fields `id`, `articleId`, `answeredOriginal` are correctly populated for sample rows.
