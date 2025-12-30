# ClickHouse + Parquet Migration Plan

> **Goal**: Migrate judgments analytics from PostgreSQL to a Parquet-first architecture with ClickHouse as the query engine, while keeping PostgreSQL for fast judgment `id` lookups (detail page) with a **slimmed-down schema**.

## Why ClickHouse? PostgreSQL Optimization Exhausted (2024-12-19)

After extensive investigation, we've concluded that **PostgreSQL cannot efficiently serve the `/api/articlesreviews` query pattern**. This query requires:

1. **Cross-prompt answer filters** (HAVING clause aggregating multiple prompts)
2. **Sorting** by `article_created_at DESC`
3. **Pagination** with LIMIT/OFFSET

### Optimizations Attempted (All Failed to Achieve <5s)

| Approach | Result |
|----------|--------|
| Denormalized fields (removed JOINs) | ⚠️ Reduced from ~120s to ~50s |
| Two-Phase Fetch (literal UUIDs) | ⚠️ Phase 2 fast (~200ms), Phase 1 still ~50s |
| Removed COUNT(DISTINCT) from HAVING | ⚠️ Minor improvement, still ~40s |
| EXISTS on articles table | ❌ Answer filters require aggregation, EXISTS can't help |
| Pre-computed stats table (JSONB) | ❌ GIN index + ORDER BY don't combine well |
| Flattened answer table | ❌ Cross-prompt filters require self-joins |
| Partial/Covering indexes | ❌ Index helps row access, not aggregation |
| Async count endpoint | ✅ UX improvement only (data loads faster) |

### The Fundamental Problem

The query must:
1. Scan millions of judgment rows matching the prompt filter
2. Group by `article_id` (~500K groups)
3. Compute HAVING aggregates per group
4. Sort all groups by `article_created_at`
5. Return top 100

Steps 2-5 operate on aggregated data and **cannot be optimized by indexes**. PostgreSQL's row-based engine must process all matching rows before returning results.

### Why ClickHouse Solves This

ClickHouse is designed for exactly this pattern:
- **Columnar storage**: Only reads columns needed for the query
- **Vectorized execution**: Processes data in batches, not row-by-row
- **Parallel aggregation**: Distributes GROUP BY across CPU cores
- **Efficient sorting**: Sorts during merge, not as a separate step

Expected improvement: **~50s → <2s**

For detailed investigation, see `DENORM_API_PLAN.md` Phase 2.7.

---

## Architecture Overview (Parquet-First, ClickHouse-Managed)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Application                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   WRITE PATH                           READ PATH                         │
│   ──────────                           ─────────                         │
│                                                                          │
│   LLM Worker                                                             │
│       │                                                                  │
│       ├──────────────────────────────────────────────────────────┐      │
│       │                                                          │      │
│       ▼                                                          ▼      │
│   ┌────────────┐         ┌──────────────────────────────┐   PostgreSQL  │
│   │  Parquet   │── S3 ──▶│  SeaweedFS (local dev)       │   (slim)      │
│   │  Writer    │         │  Ceph RGW (OpenShift prod)   │   └─ Detail   │
│   └────────────┘         │  (Parquet Files - SoT)       │      View     │
│                          └──────────────────────────────┘               │
│                                     │                                    │
│                                     │ S3Queue Engine                     │
│                                     ▼                                    │
│                          ┌──────────────────────────────┐               │
│                          │         ClickHouse           │◀── Analytics  │
│                          │  ┌────────────────────────┐  │    Queries    │
│                          │  │ judgments_queue        │  │               │
│                          │  │ (S3Queue Engine)       │  │               │
│                          │  └────────────────────────┘  │               │
│                          │              │               │               │
│                          │              │ Materialized  │               │
│                          │              │ View          │               │
│                          │              ▼               │               │
│                          │  ┌────────────────────────┐  │               │
│                          │  │ judgments              │  │               │
│                          │  │ (MergeTree)            │  │               │
│                          │  └────────────────────────┘  │               │
│                          └──────────────────────────────┘               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Environment-Specific S3 Storage

| Environment | S3 Provider | Notes |
|-------------|-------------|-------|
| **Local Dev (Mac)** | **SeaweedFS** | Lightweight, S3-compatible, single container |
| **Production (OpenShift)** | **Ceph RGW via ODF** | Native OpenShift Data Foundation integration |

**Why not MinIO?** MinIO's community edition entered maintenance mode in 2024 (no new features, case-by-case security fixes only). SeaweedFS and Ceph RGW are actively maintained alternatives.

**Dev/Prod Parity**: Both use identical S3 API — only the endpoint URL and credentials change between environments. Same code, same ClickHouse DDL.

---

## Core Design Decisions

### 1. Parquet as Source of Truth
**Decision**: The canonical record of a judgment is the Parquet file. PostgreSQL is treated as a downstream "materialized view" used only for serving specific UI needs (like `ById` lookups) that are inefficient in columnar stores.
- **Benefit**: Decouples the core data asset from the operational database.
- **Tradeoff**: **Eventual Consistency**. There will be a slight delay (seconds) between a judgment being written and it appearing in the PostgreSQL-backed Detail page.

### 2. Immutability & Soft Deletes (Tombstone Pattern)
**Decision**: Parquet files are **append-only and immutable**. Logical deletes are handled via **tombstone records**.
- **Append-Only**: Each Parquet file, once written, is never modified.
- **Soft Deletes via Tombstones**: To delete a judgment, write a new record with the same `id` but with `deletedAt` set to the deletion timestamp. The original record remains in Parquet, but downstream queries see the "tombstone" as the current state.
- **Deduplication Required**: Since the same `id` can appear multiple times (original + tombstone), ClickHouse uses `ReplacingMergeTree(deletedAt)` to deduplicate. Queries use `FINAL` or subquery patterns to get the latest state.
- **Query Filtering**: After deduplication, filter with `WHERE deletedAt IS NULL` to exclude soft-deleted judgments.

### 3. Partitioning Strategy
**Decision**: Partition strictly by time using Hive-style partitioning.
- **Structure**: `/data/judgments/year=YYYY/month=MM/{ulid}.parquet`
- **Naming**: Using `ulid` ensures time-sorted, unique filenames.

### 4. ClickHouse as the Central Sync Engine
**Decision**: ClickHouse handles *all* downstream synchronization via Materialized Views and table engines.
- **No custom Node.js "Tailer"**: We eliminate the unreliability of `fs.watch`/`chokidar`.
- **S3Queue Engine**: Processes each new Parquet file exactly once, with built-in checkpointing.
- **Materialized Views**: Automatically route new data to the main `MergeTree` analytics table.

### 5. PostgreSQL Stays Slim
**Decision**: PostgreSQL `judgments` table keeps only fields needed for the detail view. All denormalized and snapshot fields move exclusively to Parquet/ClickHouse.

**Fields to KEEP in PostgreSQL** (for detail view):
- `id`, `createdAt`, `updatedAt`, `deletedAt`
- `articleId`, `modelId`, `promptId`, `projectId`, `reviewId`
- `isAnswered`
- `answeredOriginal`, `answeredOriginalAsArray`, `answeredTransformed`
- `confidenceOriginal`, `explanation`, `quotes`

**Fields to REMOVE from PostgreSQL** (analytics only, live in ClickHouse):
- `articleTitle`, `articleCreatedAt`, `articleUpdatedAt`
- `articleCreatedYear`, `articleUpdatedYear`
- `articleImportRoute`, `articleImportedBy`
- All `snapshot*` fields

**Estimated savings**: ~800-5500 bytes per row → **~8-55 GB** for 10M judgments.

---

## Sync Strategy: ClickHouse-Managed

Instead of a Node.js service, ClickHouse itself orchestrates the sync:

1.  **Ingest**: The `S3Queue` engine watches for new Parquet files in SeaweedFS/Ceph RGW.
2.  **Store**: Data flows via Materialized View into the main `MergeTree` analytics table.
3.  **No PG Sync from ClickHouse**: PostgreSQL receives writes directly from the LLM worker (core fields only).

**Benefits**:
- **Exactly-once processing**: `S3Queue` tracks consumed files internally.
- **Battle-tested reliability**: No fragile file-system watchers.
- **High performance**: ClickHouse's native Parquet reader is highly optimized.
- **Reduced operational burden**: One less service to deploy and monitor.

---

## Database Responsibilities

- **`users`, `projects`, `prompts`, `models`, `articles`**
  - PostgreSQL: ✅ Primary
  - Parquet: ❌
  - ClickHouse: ❌

- **`judgments` (core fields: answers, explanation, quotes)**
  - PostgreSQL: ✅ **Primary for detail view** (slim schema)
  - Parquet: ✅ **Primary Source of Truth** (full denormalized)
  - ClickHouse: ✅ **Analytics Engine** (full denormalized)

- **`judgments` (denormalized fields: article metadata, snapshots)**
  - PostgreSQL: ❌ **Removed** (saves ~8-55 GB)
  - Parquet: ✅ **Primary**
  - ClickHouse: ✅ **Analytics**

---

## PostgreSQL Schema: Before & After

### Before (Current — 25+ columns, large)
```typescript
judgments = {
  // Core (keep)
  id, createdAt, updatedAt, deletedAt,
  articleId, modelId, promptId, projectId, reviewId,
  isAnswered,
  answeredOriginal, answeredOriginalAsArray, answeredTransformed,
  confidenceOriginal, explanation, quotes,

  // Denormalized article fields (REMOVE - 7 columns)
  articleTitle, articleCreatedAt, articleUpdatedAt,
  articleCreatedYear, articleUpdatedYear,
  articleImportRoute, articleImportedBy,

  // Snapshots (REMOVE - 9 columns)
  snapshotProjectId, snapshotProjectOwnerId,
  snapshotProjectUseTitle, snapshotProjectUseAbstract, snapshotProjectUseFulltext,
  snapshotProjectModelName, snapshotProjectProvider,
  snapshotArticleOriginalData, snapshotArticlePdfHash,
}
```

### After (Slim — 16 columns)
```typescript
judgments = {
  // Core identifiers
  id, createdAt, updatedAt, deletedAt,
  articleId, modelId, promptId, projectId, reviewId,

  // Answer data (for detail view)
  isAnswered,
  answeredOriginal,
  answeredOriginalAsArray,
  answeredTransformed,
  confidenceOriginal,
  explanation,
  quotes,
}
```

---

## Denormalized Judgment Schema (for Parquet/ClickHouse)

This schema represents the flat record written to Parquet and ingested by ClickHouse.

```typescript
interface DenormalizedJudgmentAnalytics {
  // Primary Identifier (Unique - no deduplication needed)
  id: string

  // Lifecycle
  createdAt: Date
  deletedAt: Date | null // Soft delete support

  // Analytic Dimensions
  // NOTE: No projectId - project scoping is done via promptIds (derived from
  // project_prompts table) and articleImportRoute (for scope filtering).
  // This avoids redundancy since projectId is never used directly in WHERE clauses.
  articleId: string
  articleTitle: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleCreatedYear: number | null
  articleUpdatedYear: number | null
  articleImportRoute: string | null
  articleImportedBy: string | null
  promptId: string
  modelId: string

  // Answer Data
  answeredOriginal: string | null // For single-value answers
  answeredOriginalAsArray: string[] | null // For multi-value/array answers

  // Large Text Fields
  explanation: string | null
  quotes: string | null // Serialized JSON
}
```

---

## ClickHouse DDL (Conceptual)

```sql
-- ============================================================
-- 1. SOURCE TABLE: S3Queue ingests new Parquet files
-- ============================================================
CREATE TABLE judgments_queue (
    id String,
    createdAt DateTime64(3),
    deletedAt Nullable(DateTime64(3)),
    articleId String,
    articleTitle String,
    articleCreatedAt Nullable(DateTime64(3)),
    articleUpdatedAt Nullable(DateTime64(3)),
    articleCreatedYear Nullable(Int16),
    articleUpdatedYear Nullable(Int16),
    articleImportRoute Nullable(String),
    articleImportedBy Nullable(String),
    promptId String,
    modelId String,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(String),
    explanation Nullable(String),
    quotes Nullable(String)
) ENGINE = S3Queue(
    -- Local dev: SeaweedFS
    'http://seaweedfs:8333/forska-judgments/**/*.parquet',
    'admin',
    'admin',
    'Parquet'
    -- Production: Replace with Ceph RGW endpoint
    -- 'http://ceph-rgw.openshift-storage.svc:8080/forska-judgments/**/*.parquet',
    -- '<ceph_access_key>',
    -- '<ceph_secret_key>',
    -- 'Parquet'
)
SETTINGS
    mode = 'ordered',
    s3queue_processing_threads_num = 4;

-- ============================================================
-- 2. MAIN ANALYTICS TABLE: ReplacingMergeTree for tombstone deduplication
-- ============================================================
CREATE TABLE judgments (
    id String,
    createdAt DateTime64(3),
    deletedAt Nullable(DateTime64(3)),
    articleId String,
    articleTitle String,
    articleCreatedAt Nullable(DateTime64(3)),
    articleUpdatedAt Nullable(DateTime64(3)),
    articleCreatedYear Nullable(Int16),
    articleUpdatedYear Nullable(Int16),
    articleImportRoute Nullable(String),
    articleImportedBy Nullable(String),
    promptId String,
    modelId String,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(String),
    explanation Nullable(String),
    quotes Nullable(String)
) ENGINE = ReplacingMergeTree(deletedAt)
PARTITION BY toYYYYMM(createdAt)
ORDER BY (id);  -- ORDER BY must include the dedup key (id)
-- NOTE: ReplacingMergeTree keeps the row with the MAX deletedAt value.
-- Tombstones (deletedAt IS NOT NULL) will replace originals (deletedAt IS NULL).

-- ============================================================
-- 3. MATERIALIZED VIEW: Route from Queue to Main Table
-- ============================================================
CREATE MATERIALIZED VIEW judgments_mv TO judgments AS
SELECT * FROM judgments_queue;
```

**Note**: No PostgreSQL sink from ClickHouse. PostgreSQL receives writes directly from the LLM worker.

---

## Query Patterns (With Deduplication)

Since soft deletes use tombstone records, queries must deduplicate to get the latest state of each `id`.

### Pattern 1: Fetching Judgments with Filters

```sql
-- Option A: Use FINAL (simple but slower for large tables)
SELECT *
FROM judgments FINAL
WHERE promptId IN ('promptA', 'promptB')  -- Project's enabled prompts
  AND deletedAt IS NULL;  -- Exclude soft-deleted (tombstones)

-- Option B: Subquery with argMax (faster for analytics)
SELECT *
FROM (
    SELECT
        argMax(id, coalesce(deletedAt, toDateTime64(0, 3))) AS id,
        argMax(createdAt, coalesce(deletedAt, toDateTime64(0, 3))) AS createdAt,
        max(deletedAt) AS deletedAt,
        -- ... other columns with argMax
    FROM judgments
    WHERE promptId IN ('promptA', 'promptB')
    GROUP BY id
)
WHERE deletedAt IS NULL;
```

### Pattern 2: Aggregation Queries (e.g., Count by Prompt)

```sql
-- Use FINAL to ensure tombstones are applied before aggregation
SELECT
    promptId,
    countIf(answeredOriginal IS NOT NULL) AS answeredCount,
    count() AS totalCount
FROM judgments FINAL
WHERE deletedAt IS NULL
GROUP BY promptId;
```

### Pattern 3: Filtering by Prompt and Answer

```sql
SELECT
    articleId,
    articleTitle,
    answeredOriginal
FROM judgments FINAL
WHERE promptId = 'yyy'
  AND answeredOriginal IS NOT NULL
  AND deletedAt IS NULL
ORDER BY createdAt DESC;
```


### Pattern 4: `/api/articlesreviews` Query (The Hard One)

This is the query pattern that PostgreSQL couldn't handle efficiently (~50s). In ClickHouse, it should run in **1-5 seconds**.

```sql
SELECT
    articleId,
    any(articleTitle) AS articleTitle,
    max(articleCreatedAt) AS articleCreatedAt,
    groupArray((promptId, answeredOriginal)) AS answers
FROM judgments FINAL  -- Deduplicate to apply tombstones
WHERE promptId IN ('promptA', 'promptB')  -- Project's enabled prompts
  AND deletedAt IS NULL  -- Exclude soft-deleted
  AND (
    articleImportRoute IN ('route1', 'route2')  -- Import routes
    OR articleId IN (SELECT article_id FROM project_articles WHERE project_id = 'xxx')  -- Curated
  )
GROUP BY articleId
HAVING
    -- Answer filters: "promptA answered 'Yes' AND promptB answered 'No'"
    sumIf(1, promptId = 'promptA' AND hasAny(answeredOriginalAsArray, ['Yes'])) > 0
    AND sumIf(1, promptId = 'promptB' AND hasAny(answeredOriginalAsArray, ['No'])) > 0
ORDER BY articleCreatedAt DESC
LIMIT 100 OFFSET 0
```

**Why this is fast in ClickHouse:**
- **Columnar storage**: Only reads needed columns (not entire rows)
- **Vectorized execution**: Processes millions of rows in SIMD batches
- **Parallel aggregation**: GROUP BY uses all CPU cores
- **Partition pruning**: Can skip irrelevant date partitions

**Expected performance**: 1-5 seconds (vs ~50s in PostgreSQL)

### FINAL vs Subquery Trade-off

- **`FINAL` clause**: Simple to write, but reads all data before deduplicating. Good for small-to-medium tables or when combined with aggressive `WHERE` filtering.
- **Subquery with `argMax()`**: More complex SQL, but can be faster for very large tables when you only need specific columns.
- **Background merges**: `ReplacingMergeTree` merges duplicate rows in the background. Over time, fewer duplicates remain, making `FINAL` cheaper.
- **Recommendation**: Start with `FINAL` for simplicity. Optimize to subquery only if performance is insufficient.

---

## Future Optimization: Pre-Aggregated Article Table

If the 1-5 second latency for Pattern 4 is not acceptable, we can add a **pre-aggregated table** that stores one row per article with all prompt answers embedded.

### Schema

```sql
CREATE TABLE article_answers (
    articleId String,
    articleTitle String,
    articleCreatedAt DateTime64(3),
    articleImportRoute Nullable(String),

    -- Map of promptId -> answers (dynamic, handles new prompts automatically)
    promptAnswers Map(String, Array(String)),

    updatedAt DateTime64(3)
)
ENGINE = ReplacingMergeTree(updatedAt)
PARTITION BY toYYYYMM(articleCreatedAt)
ORDER BY (articleCreatedAt, articleId);  -- Pre-sorted for ORDER BY DESC!
```

### Materialized View to Populate

```sql
CREATE MATERIALIZED VIEW article_answers_mv TO article_answers AS
SELECT
    articleId,
    anyLast(articleTitle) AS articleTitle,
    max(articleCreatedAt) AS articleCreatedAt,
    anyLast(articleImportRoute) AS articleImportRoute,
    mapFromArrays(
        groupArray(promptId),
        groupArray(coalesce(answeredOriginalAsArray, [answeredOriginal]))
    ) AS promptAnswers,
    max(createdAt) AS updatedAt
FROM judgments
GROUP BY articleId;
```

### Optimized Query

```sql
SELECT articleId, articleTitle, articleCreatedAt, promptAnswers
FROM article_answers
WHERE
    (articleImportRoute IN ('route1', 'route2') OR articleId IN (...))
    AND hasAny(promptAnswers['promptA'], ['Yes'])
    AND hasAny(promptAnswers['promptB'], ['No'])
ORDER BY articleCreatedAt DESC
LIMIT 100
```

**Expected performance**: <100ms (no aggregation, uses ORDER BY index)

### When to Implement

- **Start with** the simple `judgments` table (Pattern 4)
- **Measure** actual query latency with production data
- **If >5 seconds**, implement the `article_answers` table
- **Trade-off**: Additional complexity for ~50x speed improvement

---

# Implementation Checklist

## Phase 1: Infrastructure Setup (SeaweedFS + ClickHouse) ✅ COMPLETE

Set up the new infrastructure **before** modifying any existing code or schema.

- [x] **docker-compose.yml**: Add SeaweedFS container *(2024-12-19)*
  - [x] Image: `chrislusf/seaweedfs:latest`
  - [x] Command: `server -s3 -dir=/data -s3.port=8333`
  - [x] Ports: `8333:8333` (S3 API), `9333:9333` (Master UI)
  - [x] Volume: `./data/seaweedfs:/data`
- [x] **docker-compose.yml**: Add ClickHouse container *(2024-12-19)*
  - [x] Image: `clickhouse/clickhouse-server:24.9` (LTS)
  - [x] Ports: `8123:8123` (HTTP), `9000:9000` (Native)
  - [x] Volume: `./data/clickhouse:/var/lib/clickhouse`
  - [x] Environment: `CLICKHOUSE_DB=forska`, `CLICKHOUSE_USER=default`, `CLICKHOUSE_PASSWORD=clickhouse`
- [x] **Verify local setup**: Both containers running and accessible *(2024-12-19)*
  - SeaweedFS: S3 API at `localhost:8333`, Master UI at `localhost:9333`
  - ClickHouse: HTTP API at `localhost:8123`, Native at `localhost:9000`
  - Bucket `forska-judgments` created in SeaweedFS

## Phase 2: Parquet Writer ✅ COMPLETE

Build the Parquet writer that will become the new write path.

- [x] **Schema**: Define `DenormalizedJudgmentAnalytics` TypeScript interface *(2024-12-22)*
  - Created `src/services/parquet/types.ts` with full schema
- [x] **Parquet Writer**: Create `src/services/parquet/parquetWriter.ts` *(2024-12-22)*
  - [x] Use `@dsnp/parquetjs` for Parquet serialization
  - [x] Implement `writeBatch(judgments)` that writes to S3 (SeaweedFS)
  - [x] Path format: `{bucket}/year=YYYY/month=MM/{ulid}.parquet`
  - [x] Includes `JudgmentParquetWriter` class for streaming/batched writes
  - [x] Supports tombstone records for soft deletes via `writeTombstone()`
- [x] **S3 Client**: Create `src/services/s3/s3Client.ts` *(2024-12-22)*
  - [x] Use `@aws-sdk/client-s3` configured for SeaweedFS/Ceph RGW endpoints
  - [x] Environment-based configuration: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
  - [x] Utility functions: `ensureBucket`, `uploadToS3`, `downloadFromS3`, `listObjects`, `deleteFromS3`

## Phase 3: Full Backfill PostgreSQL → Parquet

Backfill all existing judgments to Parquet first, so we have real data to test ClickHouse with.

> **Note**: Originally Phase 4, moved earlier because using real ~25M judgments for testing is more practical than a synthetic 1000-row subset.

- [x] **Script**: Create `scripts/backfillPostgresToParquet.ts` *(2024-12-22)*
  - [x] Stream rows from PostgreSQL `judgments` table (with JOINs to get article metadata)
  - [x] Denormalize each judgment into `DenormalizedJudgmentAnalytics` format
  - [x] Write batches to Parquet files in SeaweedFS
  - [x] Use judgment's `createdAt` for partitioning
  - [x] Log progress with rate and ETA
  - [x] Configurable: `LIMIT` (default 1000), `BATCH_SIZE`, `OFFSET`, `DRY_RUN`
  - [x] **Optimized**: Created `scripts/backfillPostgresToParquetDuckDB.ts` using DuckDB for ~2750x faster export *(2024-12-23)*
- [x] **Test run (1000 rows)**: Verify script works with limited subset *(2024-12-23)*
  - [x] Set S3 env vars: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
  - [x] Run: `bun scripts/backfillPostgresToParquetDuckDB.ts`
  - [x] Verify Parquet file written to SeaweedFS
  - [x] Inspect with DuckDB/pandas (see script output for commands)
- [x] **Full backfill**: Run with `LIMIT=0` to process all ~25M rows *(2024-12-23)*
  - Completed in **6 minutes 19 seconds** using DuckDB script
  - **24,946,050 rows** exported to 5 Parquet files (~10.3 GB total, ~2.5 GB compressed in S3)
- [x] **Verify files**: Confirm Parquet files are written to SeaweedFS with expected partitioning *(2024-12-23)*
  - Files at: `s3://forska-judgments/judgments/year=2025/month={08,09,10,11,12}/data_0.parquet`
  - Verified with DuckDB: `SELECT COUNT(*) FROM read_parquet('s3://...')` returns 24,946,050

## Phase 4: ClickHouse DDL & Testing

Set up ClickHouse tables and verify ingestion using the real backfilled data.

> **Note**: Originally Phase 3's "test script" was skipped — we use the real backfilled Parquet files instead.

- [x] **Create ClickHouse tables** (run DDL from above):
  - [x] `judgments_queue` (S3Queue watching SeaweedFS)
  - [x] `judgments` (MergeTree)
  - [x] `judgments_mv` (Materialized View)
  - [x] **Note**: Added `keeper-config.xml` to configure embedded ClickHouse Keeper (required for S3Queue)
- [x] **Verify ingestion**: Confirm row counts in ClickHouse match PostgreSQL
  - [x] 24,946,050 rows ingested (100% match)
- [x] **Test queries**: Run sample queries (Pattern 1-4 from above) against the real data
  - [x] Complex aggregation query: **2.5s** (vs ~50s in Postgres)
- [x] **Validate correctness**: Compare ClickHouse results with PostgreSQL for spot-check queries
  - [x] Verified schema mapping and field population

## Phase 5: Dual-Write & Validation

A safe transition phase where both paths are active.

- [ ] **LLM Worker (Dual Write)**: Modify the worker to:
  - [ ] Write to **both** PostgreSQL (existing path) AND Parquet/S3 (new path)
  - [ ] The worker fetches article/project/prompt data and packages it into `DenormalizedJudgmentAnalytics`
- [ ] **Monitoring**: Add metrics/alerts to compare:
  - [ ] Row counts in PostgreSQL `judgments` vs ClickHouse `judgments`
  - [ ] Ingestion latency (time from Parquet write to ClickHouse availability)
- [ ] **Validation Queries**: Ensure analytics queries return consistent results from both systems

## Phase 6: Switch Analytics Queries to ClickHouse

> **Note**: Running Phase 6 before Phase 5 (Dual-Write) because we want to validate ClickHouse query performance with the existing backfilled data before modifying the write path.

- [x] **Create ClickHouse client**: `src/services/clickhouse/clickhouseClient.ts` *(2024-12-23)*
  - Singleton client with environment-based configuration
  - Default connection: `localhost:8123`, database `forska`
- [x] **Create ClickHouse query service**: `src/services/clickhouse/articlesReviewsClickHouse.ts` *(2024-12-23)*
  - Two-phase query: aggregate articles, then fetch judgments
  - Uses PostgreSQL for project metadata (prompts, routes, curated articles)
  - ClickHouse for judgment data (GROUP BY, HAVING, ORDER BY)
- [x] **Create test endpoint**: `/api/articlesreviews/clickhouse` *(2024-12-23)*
  - Same API contract as PostgreSQL version
  - Accessible alongside existing endpoint for A/B comparison
- [x] **Performance testing**: Verified <5s response times! *(2024-12-23)*
  - Test project: "All 2023 | AI? Healthcare?" with 4 import routes
  - Articles query: **1.36s** (GROUP BY + ORDER BY on 24.9M rows)
  - Judgments query: **0.29s** (fetch judgment details)
  - **Total: 1.67s** (vs ~50s in PostgreSQL = **96% improvement!**)
  - `FINAL` clause removed for performance (no duplicates in current data)
- [x] **Update `/api/articlesreviews`**: Replace PostgreSQL with ClickHouse (after validation) *(2024-12-30)*
- [x] **Update `/api/articlesreviewsfilters`**: Query ClickHouse *(2024-12-30)*
  - Enum-based prompts: No database query needed (parsed from type definition)
  - Database-based prompts: Query ClickHouse for distinct answer values
- [ ] **Update other analytics endpoints using PostgreSQL `judgments` table**:
  - **Analytics (MIGRATE to ClickHouse)**:
    - [ ] `/api/articlesreviewsboth` — GROUP BY + HAVING for articles with both LLM and human assessments
    - [ ] `/api/projects/add_articles_by_filter` — Aggregation queries for `llm`, `both`, and `unassessed` list types
  - **Detail View (KEEP in PostgreSQL — per architecture decision)**:
    - [x] `/api/projectsreview` — Single article judgment lookup (O(1) by ID)
  - **Project Management (KEEP — non-analytics, prompt linking logic)**:
    - [x] `/api/projects/:id` — Orphan prompt detection and importable prompt discovery
  - **Admin Utilities (KEEP — low-volume maintenance operations)**:
    - [x] `/api/prompts/duplicates` — Counts judgments per prompt
    - [x] `/api/prompts/orphans` — LEFT JOIN to detect orphan prompts
    - [x] `/api/prompts/merge` — Write operation (updates promptId)
    - [x] `/api/prompts/invalid-judgments` — Validates judgment answers
    - [x] `/api/prompts/delete-invalid-judgments` — Write operation (deletes)
  - **Background Jobs (KEEP — simple EXISTS checks or write path logic)**:
    - [x] `fullTextJobs.ts` — Prioritizes articles with judgments (EXISTS)
    - [x] `judgmentsJobsCronGetPrompts.ts` — Checks existing judgments to avoid re-judging
  - **Services (KEEP — internal prompt linking and write path)**:
    - [x] `insertArticlesIntoProject.ts` — Auto-links prompts from judgments
    - [x] `storeSinglePromptJudgment.ts` — Checks existing before insert
    - [x] `judgeStoreJudgment.ts` — Checks existing before insert
- [ ] **Rollback plan**: Keep PostgreSQL query code available (feature flag or environment variable)

## Phase 7: Disable PostgreSQL Direct Write for New Judgments

- [ ] **Modify LLM Worker**: Write ONLY to Parquet (stop dual-write to PostgreSQL)
- [ ] **Update Detail View API**: Confirm it still works with existing PostgreSQL data
- [ ] **Monitor**: Ensure ClickHouse receives all new judgments

## Phase 8: Shrink PostgreSQL `judgments` Schema (THE GOAL 🎯)

**This is the payoff**: Remove denormalized columns from PostgreSQL to reclaim storage.

- [ ] **Create migration**: Drop columns from PostgreSQL `judgments` table
  - [ ] Remove: `articleTitle`, `articleCreatedAt`, `articleUpdatedAt`
  - [ ] Remove: `articleCreatedYear`, `articleUpdatedYear`
  - [ ] Remove: `articleImportRoute`, `articleImportedBy`
  - [ ] Remove: All `snapshot*` columns (9 columns)
- [ ] **Remove unused indexes**: Drop indexes that only served analytics queries
  - [ ] Drop: `judgments_prompt_article_created_idx`
  - [ ] Drop: `judgments_prompt_import_route_idx`
- [ ] **Run migration**: Apply schema changes (will be fast since just dropping columns)
- [ ] **Verify detail view**: Confirm GET `/api/judgment/:id` still works
- [ ] **Verify storage savings**: Check PostgreSQL database size reduction

**Expected savings**: ~8-55 GB for 10M judgments (depending on data).

## Phase 9: Cleanup & Documentation

- [ ] **Remove old code**:
  - [ ] Delete PostgreSQL analytics query code from `/api/articlesreviews`
  - [ ] Delete dual-write code from LLM worker
  - [ ] Remove denormalized column definitions from `schema.ts`
- [ ] **Update documentation**: Update README, architecture docs
- [ ] **Production deployment checklist**: Prepare runbook for OpenShift deployment
  - [ ] Switch SeaweedFS endpoint to Ceph RGW
  - [ ] Configure ObjectBucketClaim for `forska-judgments` bucket
  - [ ] Update ClickHouse DDL with production S3 endpoint

---

## Query Routing Summary

| API Endpoint | Data Source | Notes |
|--------------|-------------|-------|
| `GET /api/judgment/:id` | **PostgreSQL** | O(1) lookup, core answer data |
| `GET /api/articlesreviews` | **ClickHouse** | GROUP BY, ORDER BY, filters |
| `GET /api/articlesreviewsfilters` | **ClickHouse** | Aggregation queries |
| Stats/analytics | **ClickHouse** | All aggregation queries |

---

## Open Questions / Future Considerations

- [x] **Large curated article sets**: ~~Projects with >10K curated articles exceed ClickHouse's max query size when using IN clause.~~ **SOLVED!** *(2024-12-23)*
  - **Solution**: When curated articles > 1000, create a Memory engine temp table, insert IDs in batches, and use JOIN
  - **Performance**: 93K curated articles now works in ~1.9 seconds (82ms for insert, 1.4s for query)
  - **Code**: `articlesReviewsClickHouse.ts` detects large sets and uses `createCuratedArticlesTempTable()`
- [ ] **Compaction**: For very old partitions, periodically rewrite Parquet files to:
  - Physically remove soft-deleted records.
  - Merge many small files into fewer large files.
- [ ] **OpenShift Deployment**: Finalize Ceph RGW configuration via ODF
  - Use `ObjectBucketClaim` CRD for bucket provisioning
  - Configure ClickHouse `S3Queue` with Ceph RGW credentials
- [ ] **Detail View from ClickHouse?**: If PostgreSQL detail view is too slow after schema changes, consider querying ClickHouse for `id` lookups (~10-50ms acceptable?)

---

## Alternative: chDB for Bun (Embedded ClickHouse)

**chDB** is an embedded ClickHouse engine that runs in-process with Bun, allowing direct Parquet queries without a separate ClickHouse server.

### Installation

```bash
# Step 1: Install libchdb system dependency
curl -sL https://lib.chdb.io | bash

# Step 2: Install chdb-bun package
bun add github:chdb-io/chdb-bun

# Step 3: Build the native bindings
cd node_modules/chdb-bun && bun install && bun run build
```

### Usage

```typescript
import { query, Session } from 'chdb-bun';

// Ephemeral query (stateless)
const result = query("SELECT version()", "JSON");

// Query Parquet files directly
const parquetResult = query(`
  SELECT COUNT(*) as total
  FROM file('/path/to/file.parquet', Parquet)
`, "JSON");

// Persistent session (for creating tables, etc.)
const sess = new Session('./chdb-data');
sess.query("CREATE DATABASE IF NOT EXISTS analytics", "CSV");
sess.cleanup();
```

### When to Use chDB vs ClickHouse Server

| Use Case | Recommendation |
|----------|---------------|
| Production analytics API | **ClickHouse Server** (already has data via S3Queue) |
| Local development/testing | chDB or ClickHouse Server |
| Ad-hoc Parquet file queries | **chDB** (no server needed) |
| Backfill verification scripts | **chDB** (simple, embedded) |
| CI/CD test suites | **chDB** (no Docker dependency) |

### Limitations

- **Working directory**: chdb-bun requires running from `node_modules/chdb-bun` directory due to native library path issues
- **No S3Queue**: chDB doesn't support S3Queue engine (use for direct file queries only)
- **Memory**: Large queries consume more memory since it's in-process

**Documentation**: https://clickhouse.com/docs/chdb/install/bun
