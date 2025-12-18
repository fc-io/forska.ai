# ClickHouse + Parquet Migration Plan

> **Goal**: Migrate judgments storage from PostgreSQL to a Parquet-first architecture with ClickHouse as the query engine for analytics.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Application                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   WRITE PATH                           READ PATH                         │
│   ──────────                           ─────────                         │
│                                                                          │
│   LLM Worker                           API / Frontend                    │
│       │                                     │                            │
│       ▼                                     ▼                            │
│   ┌────────────┐                      ┌────────────┐                    │
│   │ PostgreSQL │◀─── lookup ──────────│ ClickHouse │                    │
│   │  (OLTP)    │    article/prompt    │  (Query)   │                    │
│   │            │                      │            │                    │
│   │ • users    │                      │ External   │                    │
│   │ • projects │                      │ Table ─────┼──┐                 │
│   │ • prompts  │                      └────────────┘  │                 │
│   │ • articles │                                      │ reads           │
│   └────────────┘                                      ▼                 │
│        │                              ┌───────────────────────────────┐ │
│        │ denormalize                  │        Parquet Files          │ │
│        ▼                              │      (Durable Storage)        │ │
│   ┌────────────┐                      │                               │ │
│   │  Parquet   │─────  append  ──────▶│  /data/judgments/             │ │
│   │  Writer    │                      │    year=2024/                 │ │
│   │ (parquetjs)│                      │      month=12/                │ │
│   └────────────┘                      │        project=xxx/           │ │
│                                       │          data.parquet         │ │
│                                       └───────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Why This Architecture?

### Problems with Current PostgreSQL Setup
- Complex JOINs on 10.5M articles × 24.9M judgments are slow (20-300 seconds)
- Row-oriented storage inefficient for analytical queries
- Scaling to 100M+ judgments will make queries unusable

### Benefits of Parquet-First
| Aspect | Benefit |
|--------|---------|
| **No sync needed** | Parquet IS the source of truth for judgments |
| **Columnar storage** | 10-100x faster aggregations |
| **Portable** | Readable by ClickHouse, Polars, Spark, and other tools |
| **Durable** | Files are immutable, easy to backup |
| **Denormalized** | No JOINs needed at query time |

## Data Flow

```
1. LLM returns judgment
        │
        ▼
2. Lookup article/prompt/project from PostgreSQL (cached)
        │
        ▼
3. Build denormalized record
        │
        ▼
4. Add to batch buffer
        │
        ▼
5. On flush: Append to Parquet file (partitioned)
        │
        ▼
6. ClickHouse queries Parquet files directly
        │
        ▼
7. API returns results
```

## Database Responsibilities

| Table | PostgreSQL | Parquet/ClickHouse |
|-------|------------|-------------------|
| `users`, `sessions` | ✅ Primary | ❌ |
| `projects` | ✅ Primary | ❌ |
| `prompts` | ✅ Primary | ❌ |
| `articles` | ✅ Primary | Denormalized copy in judgments |
| `judgments` | ✅ Detail page lookups | ✅ Primary for analytics (Parquet) |
| `judgments_jobs` | ✅ Primary | ❌ |
| `project_articles` | ✅ Primary | ❌ |
| `token_use` | ✅ Primary | Optional: move later |

### Query Routing Strategy

| Query Type | Database | Example |
|------------|----------|---------|
| **Analytics** (list, filter, aggregate) | Parquet/ClickHouse | `/api/articlesreviews`, `/api/articlesreviewsfilters` |
| **Detail page** (single article lookup) | PostgreSQL | `/api/projectsreview` (article detail with full judgment info) |
| **Writes** | PostgreSQL → Parquet | LLM judgment creation writes to Parquet |

**Rationale**: Single-row lookups don't benefit from columnar storage. The article detail page fetches full judgment details (explanation, quotes, confidence) from PostgreSQL, while list/filter/aggregate queries use Parquet.

## Denormalized Judgment Schema

Each Parquet record contains fields needed for **analytics queries** (filtering, aggregation, list display):

```typescript
interface DenormalizedJudgment {
  // Primary identifiers
  id: string
  createdAt: Date
  updatedAt: Date

  // Core judgment data (for filtering/aggregation)
  articleId: string
  promptId: string
  modelId: string
  isAnswered: boolean
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null

  // Denormalized: Article fields (for filtering/display)
  articleTitle: string
  articleSummary: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleArxivId: string | null
  articleOpenalexId: string | null
  articleImportRoute: string | null

  // Denormalized: Prompt fields (for filtering/display)
  promptHeading: string | null
  promptType: string | null
  promptContentHash: string | null

  // Denormalized: Project fields (for scoping/display)
  projectId: string
  projectName: string | null
  projectOwnerId: string | null
  projectUseTitle: boolean
  projectUseAbstract: boolean
  projectUseFulltext: boolean

  // Denormalized: Model fields (for filtering by model)
  modelName: string | null
  modelProvider: string | null
}
```

**Fields intentionally excluded** (fetched from PostgreSQL on detail page):
- `explanation` — Large text, only shown on detail page
- `quotes` — JSON array, only shown on detail page
- `confidenceOriginal` — Only shown on detail page
- `articleDoi` — Only shown on detail page
- `promptOriginalText` — Large text, only shown on detail page

## Partitioning Strategy

```
/data/judgments/
├── year=2024/
│   ├── month=01/
│   │   ├── project=abc-123/
│   │   │   └── data.parquet
│   │   └── project=def-456/
│   │       └── data.parquet
│   └── month=12/
│       └── ...
└── year=2025/
    └── ...
```

**Rationale:**
- `year/month`: Time-based pruning for date range queries
- `project`: Most queries filter by project, ClickHouse skips irrelevant files

---

# Implementation Checklist

## Phase 0: Denormalize PostgreSQL Judgments Table

Before migrating to Parquet, add denormalized columns to the existing `judgments` table. This allows:
- Backfilling existing judgments with denormalized data
- Testing the denormalized schema in PostgreSQL before committing to Parquet
- Easier export to Parquet (no JOINs needed during export)

### 0.1 Columns to Add (Database Migration)

**Currently in `judgments` table:**
- ✅ `id`, `created_at`, `updated_at`
- ✅ `article_id`, `prompt_id`, `model_id`
- ✅ `is_answered`, `answered_original`, `answered_original_as_array`
- ✅ `snapshot_project_id` (can use as `projectId`)
- ✅ `snapshot_project_owner_id` (can use as `projectOwnerId`)
- ✅ `snapshot_project_use_title/abstract/fulltext`
- ✅ `snapshot_project_model_name` (can use as `modelName`)
- ✅ `snapshot_project_provider` (can use as `modelProvider`)

**Columns to ADD:**

| Column | Type | Source |
|--------|------|--------|
| `denorm_article_title` | `text` | `articles.article_title` |
| `denorm_article_summary` | `text` | `articles.article_summary` |
| `denorm_article_created_at` | `timestamptz` | `articles.article_created_at` |
| `denorm_article_updated_at` | `timestamptz` | `articles.article_updated_at` |
| `denorm_article_arxiv_id` | `text` | `articles.arxiv_id` |
| `denorm_article_openalex_id` | `text` | `articles.openalex_id` |
| `denorm_article_import_route` | `text` | `articles.import_route` |
| `denorm_prompt_heading` | `text` | `prompts.prompt_heading` |
| `denorm_prompt_type` | `text` | `prompts.type` |
| `denorm_prompt_content_hash` | `text` | `prompts.content_hash` |
| `denorm_project_name` | `text` | `projects.name` |

### 0.2 Migration Steps

- [ ] Create migration file `src/db/migrations/00XX_denormalize_judgments.sql`
- [ ] Add new columns (all nullable initially)
- [ ] Create indexes on new columns for efficient queries:
  - `denorm_article_created_at` (for date range filtering)
  - `denorm_article_title` with trigram (for ILIKE search)
  - `denorm_prompt_heading` (for display)

### 0.3 Backfill Script

- [ ] Create `scripts/backfill-denormalized-judgments.ts`
- [ ] Batch update existing judgments with denormalized data
- [ ] Use batches of ~10,000 rows to avoid long locks
- [ ] Add progress logging (24.9M rows will take time)
- [ ] Handle NULL cases gracefully (deleted articles/prompts)

### 0.4 Update LLM Worker

- [ ] Modify judgment creation to populate denormalized columns at write time
- [ ] Fetch article/prompt data once, write to both normalized + denormalized columns
- [ ] Test with new judgments before running backfill

### 0.5 Validate Denormalization

- [ ] Verify denormalized data matches JOINed data
- [ ] Spot-check sample of rows across different projects
- [ ] Confirm no data corruption

---

## Phase 1: Parquet Writer

### 1.1 Setup & Dependencies
- [ ] Install Parquet library: `bun add @dsnp/parquetjs`
- [ ] Create `/data/judgments/` directory structure
- [ ] Add `/data/` to `.gitignore`

### 1.2 Parquet Writer Service
- [ ] Create `src/services/parquet/types.ts` with `DenormalizedJudgment` interface
- [ ] Create `src/services/parquet/parquetWriter.ts` using `@dsnp/parquetjs`
- [ ] Define Parquet schema matching `DenormalizedJudgment`
- [ ] Implement `appendToParquet(partition, records)` function
- [ ] Add ZSTD compression for Parquet files
- [ ] Add error handling and retry logic

### 1.3 Batch Buffer
- [ ] Create `src/services/parquet/judgmentBatcher.ts`
- [ ] Implement buffer with configurable batch size (default: 1000)
- [ ] Implement flush interval (default: 10 seconds)
- [ ] Add graceful shutdown handler to flush on SIGTERM
- [ ] Add metrics/logging for batch operations

### 1.4 Integration with LLM Worker
- [ ] Modify judgment creation flow to also write to Parquet
- [ ] Use denormalized columns from PostgreSQL (already populated)
- [ ] Test with small batch of judgments
- [ ] Verify Parquet files are created correctly

### 1.5 Parquet Reader (for validation)
- [ ] Create `src/services/parquet/parquetReader.ts`
- [ ] Implement basic read functions for testing
- [ ] Test reading back written judgments

---

## Phase 2: Migrate Existing Judgments

### 2.1 Export Script
- [ ] Create `scripts/export-judgments-to-parquet.ts`
- [ ] Export existing PostgreSQL judgments with denormalization
- [ ] Partition by year/month/project during export
- [ ] Add progress logging (24.9M rows will take time)
- [ ] Verify row counts match after export

### 2.2 Validate Migration
- [ ] Compare query results: PostgreSQL vs Parquet
- [ ] Check for data integrity issues
- [ ] Document any discrepancies

---

## Phase 3: API Layer Changes

### 3.1 Query Routing
- [ ] Create abstraction layer for judgment queries
- [ ] Route analytics queries to ClickHouse
- [ ] Keep transaction queries on PostgreSQL (if any)

### 3.2 Update API Routes
- [ ] Modify `/api/articlesreviews` to query Parquet
- [ ] Modify `/api/articlesreviewsfilters` to query Parquet
- [ ] Update article details page judgment display
- [ ] Test all affected frontend pages

### 3.3 Performance Validation
- [ ] Benchmark new queries vs old
- [ ] Document performance improvements
- [ ] Fix any regressions

---

## Phase 4: ClickHouse Integration (Later)

### 4.1 ClickHouse Setup
- [ ] Add ClickHouse to `docker-compose.yml`
- [ ] Configure ClickHouse for local development
- [ ] Document HPC deployment for ClickHouse

### 4.2 External Table Setup
- [ ] Create ClickHouse external table pointing to Parquet files
- [ ] Test queries via ClickHouse
- [ ] Benchmark ClickHouse query performance on Parquet files

### 4.3 API Migration to ClickHouse
- [ ] Create ClickHouse client wrapper
- [ ] Migrate analytics queries to use ClickHouse

### 4.4 Optional: Materialized Views
- [ ] Evaluate if materialized views are needed
- [ ] Create MVs for frequently-run aggregations
- [ ] Set up refresh schedule

---

## Phase 5: Cleanup

### 5.1 PostgreSQL Cleanup
- [ ] Remove `judgments` table from PostgreSQL (after validation period)
- [ ] Update Drizzle schema
- [ ] Remove unused indexes
- [ ] Update backup scripts

### 5.2 Documentation
- [ ] Update README with new architecture
- [ ] Document Parquet file locations
- [ ] Document backup/restore procedures
- [ ] Update CLAUDE.md with new patterns

---

## Storage Considerations

### Development
- Local disk: `/data/judgments/`

### Production (HPC)
- Option A: Shared filesystem (if available)
- Option B: MinIO (self-hosted S3)
- Option C: Cloud S3 bucket

### Backup Strategy
```bash
# Simple: just copy the Parquet files
rsync -av /data/judgments/ /backup/judgments/

# Or with compression
tar -czvf judgments-backup-$(date +%Y%m%d).tar.gz /data/judgments/
```

---

## Expected Performance Improvements

| Query | PostgreSQL (current) | ClickHouse/Parquet |
|-------|---------------------|----------------|-------------------|
| Reviews page (filter + paginate) | 20-300 seconds | 50-200ms |
| Count by answer type | 5-15 seconds | 20-50ms |
| Aggregate across projects | 30-60 seconds | 100-300ms |
| Full table scan (100M rows) | Minutes | 1-2 seconds |

---

## Open Questions

- [ ] Where to store Parquet files in production? (local disk, S3, MinIO?)
- [ ] Keep PostgreSQL `judgments` table as audit log or remove entirely?
- [ ] Cache invalidation strategy when articles/prompts are updated?
- [ ] How to handle judgment updates/deletes? (append-only vs rewrite partition)

---

## References

- [@dsnp/parquetjs](https://github.com/dsnp/parquetjs)
- [ClickHouse external tables](https://clickhouse.com/docs/en/engines/table-engines/integrations/s3)
- [Parquet file format](https://parquet.apache.org/)
