# ClickHouse + Parquet Migration Plan

> **Goal**: Migrate judgments analytics from PostgreSQL to a Parquet-first architecture with ClickHouse as the query engine, while keeping PostgreSQL for fast judgment `id` lookups (detail page).

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
│       ▼                                                                  │
│   ┌────────────┐              ┌────────────────────────────────┐        │
│   │  Parquet   │──  write ───▶│  S3 / MinIO / Local Disk       │        │
│   │  Writer    │              │  (Parquet Files - SoT)         │        │
│   └────────────┘              └────────────────────────────────┘        │
│                                          │                              │
│                                          │ S3Queue / File Engine        │
│                                          ▼                              │
│                               ┌────────────────────────────────┐        │
│                               │         ClickHouse             │        │
│                               │  ┌──────────────────────────┐  │        │
│                               │  │ judgments_queue          │  │        │
│                               │  │ (S3Queue Engine)         │  │        │
│                               │  └──────────────────────────┘  │        │
│                               │              │                 │        │
│                               │              │ Materialized    │        │
│                               │              │ Views           │        │
│                               │              ▼                 │        │
│                               │  ┌──────────────────────────┐  │        │
│                               │  │ judgments                │◀─┼─ Analytics
│                               │  │ (MergeTree)              │  │   Queries
│                               │  └──────────────────────────┘  │        │
│                               │              │                 │        │
│                               │              │ MV to PG        │        │
│                               │              ▼                 │        │
│                               │  ┌──────────────────────────┐  │        │
│                               │  │ pg_judgments_sink        │──┼──▶ PostgreSQL
│                               │  │ (PostgreSQL Engine)      │  │    (Detail View)
│                               │  └──────────────────────────┘  │        │
│                               └────────────────────────────────┘        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Design Decisions

### 1. Parquet as Source of Truth
**Decision**: The canonical record of a judgment is the Parquet file. PostgreSQL is treated as a downstream "materialized view" used only for serving specific UI needs (like `ById` lookups) that are inefficient in columnar stores.
- **Benefit**: Decouples the core data asset from the operational database.
- **Tradeoff**: **Eventual Consistency**. There will be a slight delay (seconds) between a judgment being written and it appearing in the PostgreSQL-backed Detail page.

### 2. Immutability & Uniqueness
**Decision**: Every judgment stored in Parquet is **unique and immutable**.
- **No Updates**: Judgments are never modified after creation. Each judgment record is a permanent, unique entry.
- **No Versioning**: There is no `updatedAt` column for deduplication - each row is inherently unique by its `id`.
- **Deletes**: Use **soft deletes** via a `deletedAt` column. Downstream consumers filter by `WHERE deletedAt IS NULL`.
- **Simplicity**: ClickHouse uses a simple `MergeTree` engine since no row deduplication is needed.

### 3. Partitioning Strategy
**Decision**: Partition strictly by time using Hive-style partitioning.
- **Structure**: `/data/judgments/year=YYYY/month=MM/{ulid}.parquet`
- **Naming**: Using `ulid` ensures time-sorted, unique filenames.

### 4. ClickHouse as the Central Sync Engine
**Decision**: ClickHouse handles *all* downstream synchronization via Materialized Views and table engines.
- **No custom Node.js "Tailer"**: We eliminate the unreliability of `fs.watch`/`chokidar`.
- **S3Queue Engine**: Processes each new Parquet file exactly once, with built-in checkpointing.
- **Materialized Views**: Automatically route new data to:
    1. The main `MergeTree` analytics table.
    2. A `PostgreSQL` engine table that syncs to Postgres.

---

## Sync Strategy: ClickHouse-Managed

Instead of a Node.js service, ClickHouse itself orchestrates the sync:

1.  **Ingest**: The `S3Queue` (or `File`) engine watches for new Parquet files.
2.  **Store**: Data flows via Materialized View into the main `MergeTree` analytics table.
3.  **Sync to Postgres**: A second Materialized View pipes data to a `PostgreSQL` engine table, which INSERTs into Postgres.

**Benefits**:
- **Exactly-once processing**: `S3Queue` tracks consumed files internally.
- **Battle-tested reliability**: No fragile file-system watchers.
- **High performance**: ClickHouse's native Parquet reader is highly optimized.
- **Reduced operational burden**: One less service to deploy and monitor.

---

## Database Responsibilities

- **`users`, `projects`, `prompts`, `models`**
  - PostgreSQL: ✅ Primary
  - Parquet: ❌
  - ClickHouse: ❌

- **`articles`**
  - PostgreSQL: ✅ Primary
  - Parquet: Denormalized copy in `judgments`
  - ClickHouse: Denormalized copy

- **`judgments`**
  - PostgreSQL: ⚠️ **Read Replica** (for ID lookup)
  - Parquet: ✅ **Primary Source of Truth**
  - ClickHouse: ✅ **Analytics Engine**

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
  projectId: string
  articleId: string
  articleTitle: string
  articleYear: number | null // Publication year for filtering
  articleImportRoute: string | null
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
    projectId String,
    articleId String,
    articleTitle String,
    articleYear Nullable(Int16),
    articleImportRoute Nullable(String),
    promptId String,
    modelId String,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(String),
    explanation Nullable(String),
    quotes Nullable(String)
) ENGINE = S3Queue(
    'http://minio:9000/data/judgments/**/*.parquet',
    'minio_access_key',
    'minio_secret_key',
    'Parquet'
)
SETTINGS
    mode = 'ordered',
    s3queue_processing_threads_num = 4;

-- ============================================================
-- 2. MAIN ANALYTICS TABLE: Simple append-only, each judgment is unique
-- ============================================================
CREATE TABLE judgments (
    id String,
    createdAt DateTime64(3),
    deletedAt Nullable(DateTime64(3)),
    projectId String,
    articleId String,
    articleTitle String,
    articleYear Nullable(Int16),
    articleImportRoute Nullable(String),
    promptId String,
    modelId String,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(String),
    explanation Nullable(String),
    quotes Nullable(String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(createdAt)
ORDER BY (projectId, articleId, promptId, id);
-- NOTE: No deduplication needed - each judgment is unique.

-- ============================================================
-- 3. MATERIALIZED VIEW: Route from Queue to Main Table
-- ============================================================
CREATE MATERIALIZED VIEW judgments_mv TO judgments AS
SELECT * FROM judgments_queue;

-- ============================================================
-- 4. POSTGRESQL SINK: For Detail View cache
-- ============================================================
CREATE TABLE pg_judgments_sink (
    id String,
    createdAt DateTime64(3),
    deletedAt Nullable(DateTime64(3)),
    projectId String,
    articleId String,
    promptId String,
    modelId String,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(String),
    explanation Nullable(String),
    quotes Nullable(String)
) ENGINE = PostgreSQL(
    'postgres:5432',
    'forska',
    'judgments_denormalized', -- Target table in Postgres
    'clickhouse_user',
    'clickhouse_password'
);

-- ============================================================
-- 5. MATERIALIZED VIEW: Route from Queue to PostgreSQL
-- ============================================================
CREATE MATERIALIZED VIEW pg_sync_mv TO pg_judgments_sink AS
SELECT
    id,
    createdAt,
    deletedAt,
    projectId,
    articleId,
    promptId,
    modelId,
    answeredOriginal,
    answeredOriginalAsArray,
    explanation,
    quotes
FROM judgments_queue;
```

**Note on Postgres Inserts**: Since each judgment is unique, ClickHouse's `PostgreSQL` engine simple `INSERT` behavior works directly without needing upsert logic.

---

## Query Patterns (Simple!)

Since each judgment is unique and immutable, queries are straightforward - no deduplication needed.

### Pattern 1: Fetching Judgments with Filters

```sql
SELECT *
FROM judgments
WHERE projectId = 'xxx'
  AND deletedAt IS NULL; -- Exclude soft-deleted
```

### Pattern 2: Aggregation Queries (e.g., Count by Project)

```sql
SELECT
    projectId,
    any(projectName) AS projectName,
    countIf(isAnswered = true) AS answeredCount,
    count() AS totalCount
FROM judgments
WHERE deletedAt IS NULL
GROUP BY projectId;
```

### Pattern 3: Filtering by Prompt and Answer

```sql
SELECT
    articleId,
    articleTitle,
    answeredOriginal
FROM judgments
WHERE projectId = 'xxx'
  AND promptId = 'yyy'
  AND isAnswered = true
  AND deletedAt IS NULL
ORDER BY createdAt DESC;
```

### Why This is Simpler

- **No `argMax()` needed**: Each row is unique, no version deduplication
- **No `ReplacingMergeTree`**: Simple `MergeTree` engine with better performance
- **No `FINAL` clause**: No deduplication overhead at query time
- **Direct filtering**: Just use standard `WHERE` clauses

---

# Implementation Checklist

## Phase 1: Parquet Writer (The Core)
Build the new storage engine's write path first.

- [ ] **Schema**: Define the `DenormalizedJudgment` TypeScript interface (as above).
- [ ] **Parquet Writer**: Create `src/services/parquet/parquetWriter.ts`.
  - [ ] Use `@dsnp/parquetjs` for Parquet serialization.
  - [ ] Implement `writeBatch(judgments)` to `/data/judgments/year=YYYY/month=MM/{ulid}.parquet`.
  - [ ] **Durability**: Write to a `pending/` directory first, then atomically move to the final location.

## Phase 2: Infrastructure & ClickHouse Setup
- [ ] **Object Storage**: Add MinIO to `docker-compose.yml` (S3-compatible, for `S3Queue`).
  - [ ] Configure bucket `forska-data` with path `/judgments/`.
- [ ] **ClickHouse**: Add ClickHouse to `docker-compose.yml`.
  - [ ] Configure user/password for PostgreSQL integration.
- [ ] **ClickHouse DDL**: Run the DDL above to create:
  - [ ] `judgments_queue` (S3Queue)
  - [ ] `judgments` (MergeTree)
  - [ ] `judgments_mv` (Materialized View)
- [ ] **PostgreSQL Schema**: Add `judgments_denormalized` table to Postgres.
  - [ ] Include all fields needed for the Detail View.
  - [ ] Add a trigger or use `ON CONFLICT` for upsert behavior.
- [ ] **ClickHouse PG Sync**: Create:
  - [ ] `pg_judgments_sink` (PostgreSQL Engine)
  - [ ] `pg_sync_mv` (Materialized View)

## Phase 3: Dual-Write & Validation
A safe transition phase where both paths are active.

- [ ] **LLM Worker (Dual Write)**: Modify the worker to:
  - [ ] Write to **both** PostgreSQL (existing path) AND Parquet (new path).
  - [ ] The worker fetches article/project/prompt data and packages it into `DenormalizedJudgment`.
- [ ] **Monitoring**: Add metrics/alerts to compare:
  - [ ] Row counts in Postgres `judgments` vs ClickHouse `judgments`.
  - [ ] Sync latency (time from Parquet write to Postgres `judgments_denormalized` update).
- [ ] **Validation Queries**: Ensure analytics queries return consistent results from both systems.

## Phase 4: Switch Write Path (Cutover)
- [ ] **Disable Postgres Direct Write**: Modify the worker to write ONLY to Parquet.
- [ ] **Update Detail View API**: Read from `judgments_denormalized` (Postgres) for ID lookups.
- [ ] **Update Analytics APIs**: Read from ClickHouse for all list/aggregate/filter queries.

## Phase 5: Backfill (Legacy Data)
- [ ] **Script**: Create `scripts/legacy-postgres-to-parquet.ts`.
  - [ ] Reads current Postgres `judgments` rows, JOINing with articles/projects/prompts/models.
  - [ ] Writes them to Parquet files in `/data/judgments/year=YYYY/month=MM/`.
  - [ ] Use the judgment's `createdAt` for partitioning.
- [ ] **Re-ingest in ClickHouse**: The `S3Queue` will pick up backfilled files automatically.
- [ ] **Verification**: Confirm total row counts match between Postgres and ClickHouse.

## Phase 6: Cleanup
- [ ] **Remove Old Code**: Delete the direct Postgres write path in the LLM worker.
- [ ] **Archive/Drop Old Table**: Once confident, the original normalized `judgments` table in Postgres can be deprecated.

---

## Open Questions / Future Considerations

- [ ] **Compaction**: For very old partitions, periodically rewrite Parquet files to:
  - Physically remove soft-deleted records.
  - Merge many small files into fewer large files.
- [ ] **Local Disk vs. S3**: For development, can use `File` engine instead of `S3Queue`. Decide if production uses S3/MinIO or a mounted volume.
- [ ] **Postgres Upsert Strategy**: Finalize whether to use a Postgres trigger, a staging table, or rely on ClickHouse's insert behavior with conflict handling.
