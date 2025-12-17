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
│   │  (DuckDB)  │                      │      month=12/                │ │
│   └────────────┘                      │        project=xxx/           │ │
│                                       │          data.parquet         │ │
│                                       └───────────────────────────────┘ │
│                                                     │                    │
│                                                     │ also readable by   │
│                                                     ▼                    │
│                                              ┌────────────┐             │
│                                              │  DuckDB    │             │
│                                              │ (Ad-hoc)   │             │
│                                              └────────────┘             │
└─────────────────────────────────────────────────────────────────────────┘
```

## Why This Architecture?

### Problems with Current PostgreSQL Setup
- Complex JOINs on 2M+ articles × 10M+ judgments are slow (2-30 seconds)
- Row-oriented storage inefficient for analytical queries
- Scaling to 100M+ judgments will make queries unusable

### Benefits of Parquet-First
| Aspect | Benefit |
|--------|---------|
| **No sync needed** | Parquet IS the source of truth for judgments |
| **Columnar storage** | 10-100x faster aggregations |
| **Portable** | Readable by ClickHouse, DuckDB, Polars, Spark |
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
6. ClickHouse/DuckDB queries Parquet files directly
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

## Phase 1: Parquet Writer (Start Here)

### 1.1 Setup & Dependencies
- [ ] Install DuckDB for Bun: `bun add duckdb-async` or equivalent
- [ ] Create `/data/judgments/` directory structure
- [ ] Add `/data/` to `.gitignore`

### 1.2 Parquet Writer Service
- [ ] Create `src/services/parquet/types.ts` with `DenormalizedJudgment` interface
- [ ] Create `src/services/parquet/parquetWriter.ts` with DuckDB-based writer
- [ ] Implement `appendToParquet(partition, records)` function
- [ ] Add ZSTD compression for Parquet files
- [ ] Add error handling and retry logic

### 1.3 Judgment Denormalizer
- [ ] Create `src/services/parquet/denormalizer.ts`
- [ ] Implement `denormalizeJudgment(judgment, articleId, promptId, projectId)`
- [ ] Add caching for article/prompt lookups (avoid repeated DB queries)
- [ ] Consider Redis or in-memory LRU cache for hot data

### 1.4 Batch Buffer
- [ ] Create `src/services/parquet/judgmentBatcher.ts`
- [ ] Implement buffer with configurable batch size (default: 1000)
- [ ] Implement flush interval (default: 10 seconds)
- [ ] Add graceful shutdown handler to flush on SIGTERM
- [ ] Add metrics/logging for batch operations

### 1.5 Integration with LLM Worker
- [ ] Modify judgment creation flow to use Parquet writer
- [ ] Keep PostgreSQL write as fallback/audit log (optional)
- [ ] Test with small batch of judgments
- [ ] Verify Parquet files are created correctly

### 1.6 Parquet Reader (for DuckDB queries)
- [ ] Create `src/services/parquet/parquetReader.ts`
- [ ] Implement basic query functions using DuckDB
- [ ] Test reading back written judgments
- [ ] Benchmark query performance vs PostgreSQL

---

## Phase 2: Migrate Existing Judgments

### 2.1 Export Script
- [ ] Create `scripts/export-judgments-to-parquet.ts`
- [ ] Export existing PostgreSQL judgments with denormalization
- [ ] Partition by year/month/project during export
- [ ] Add progress logging (10M+ rows will take time)
- [ ] Verify row counts match after export

### 2.2 Validate Migration
- [ ] Compare query results: PostgreSQL vs Parquet
- [ ] Check for data integrity issues
- [ ] Document any discrepancies

---

## Phase 3: API Layer Changes

### 3.1 Query Routing
- [ ] Create abstraction layer for judgment queries
- [ ] Route analytics queries to Parquet/DuckDB
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
- [ ] Compare performance: DuckDB vs ClickHouse on Parquet

### 4.3 API Migration to ClickHouse
- [ ] Create ClickHouse client wrapper
- [ ] Migrate analytics queries from DuckDB to ClickHouse
- [ ] Keep DuckDB as fallback for ad-hoc research queries

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

| Query | PostgreSQL (current) | DuckDB/Parquet | ClickHouse/Parquet |
|-------|---------------------|----------------|-------------------|
| Reviews page (filter + paginate) | 2-5 seconds | 200-500ms | 50-200ms |
| Count by answer type | 5-15 seconds | 50-100ms | 20-50ms |
| Aggregate across projects | 30-60 seconds | 200-500ms | 100-300ms |
| Full table scan (100M rows) | Minutes | 2-5 seconds | 1-2 seconds |

---

## Open Questions

- [ ] Where to store Parquet files in production? (local disk, S3, MinIO?)
- [ ] Keep PostgreSQL `judgments` table as audit log or remove entirely?
- [ ] Cache invalidation strategy when articles/prompts are updated?
- [ ] How to handle judgment updates/deletes? (append-only vs rewrite partition)

---

## References

- [DuckDB Parquet documentation](https://duckdb.org/docs/data/parquet/overview)
- [ClickHouse external tables](https://clickhouse.com/docs/en/engines/table-engines/integrations/s3)
- [Parquet file format](https://parquet.apache.org/)
