# ClickHouse + Parquet Migration Plan

> **Goal**: Migrate judgments analytics from PostgreSQL to a Parquet-first architecture with ClickHouse as the query engine, while keeping PostgreSQL (or another K/V store) for fast judgment `id` lookups (detail page).

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
│   │ PostgreSQL │                      │ ClickHouse │                    │
│   │  (OLTP)    │                      │  (Query)   │                    │
│   │            │                      │            │                    │
│   │ • users    │                      │ External   │                    │
│   │ • projects │                      │ Table ─────┼──┐                 │
│   │ • prompts  │                      └────────────┘  │                 │
│   │ • articles │                                      │ reads           │
│   │ • judgments│                                      ▼                 │
│   └────────────┘                                      ▼                 │
│        │                              ┌───────────────────────────────┐ │
│        │ denormalize                  │        Parquet Files          │ │
│        ▼                              │      (Durable Storage)        │ │
│   ┌────────────┐                      │                               │ │
│   │  Parquet   │─────  write   ──────▶│  /data/judgments/             │ │
│   │  Writer    │   (immutable)        │    year=2024/                 │ │
│   │ (parquetjs)│                      │      month=12/                │ │
│   └────────────┘                      │        project=xxx/           │ │
│                                       │          part-time-uuid.parquet │ │
│                                       └───────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

Detail page reads from PostgreSQL by `id`. Analytics reads from ClickHouse over Parquet.

## Why This Architecture?

### Problems with Current PostgreSQL Setup
- Complex JOINs on 10.5M articles × 24.9M judgments are slow (20-300 seconds)
- Row-oriented storage inefficient for analytical queries
- Scaling to 100M+ judgments will make queries unusable

### Benefits of Parquet-First
| Aspect | Benefit |
|--------|---------|
| **Simple dual-write** | PostgreSQL remains write + point-lookup store; Parquet is an append-only analytics mirror |
| **Columnar storage** | 10-100x faster aggregations |
| **Portable** | Readable by ClickHouse, Polars, Spark, and other tools |
| **Durable** | Files are immutable, easy to backup |
| **Denormalized** | No JOINs needed at query time |

## Data Flow

```
1. LLM returns judgment
        │
        ▼
2. Write judgment to PostgreSQL (authoritative, supports fast `id` lookups)
        │
        ▼
3. Lookup article/prompt/project from PostgreSQL (cached) and build denormalized analytics record
        │
        ▼
4. Add to batch buffer
        │
        ▼
5. On flush: Write immutable Parquet file (partitioned)
   [File: /data/.../part-{timestamp}-{uuid}.parquet]
        │
        ▼
6. ClickHouse queries Parquet files directly via External Table
        │
        ▼
7. API returns results (Analytics → ClickHouse, Detail → PostgreSQL)
```

## Database Responsibilities

| Table | PostgreSQL | Parquet/ClickHouse |
|-------|------------|-------------------|
| `users`, `sessions` | ✅ Primary | ❌ |
| `projects` | ✅ Primary | ❌ |
| `prompts` | ✅ Primary | ❌ |
| `articles` | ✅ Primary | Denormalized copy in judgments |
| `judgments` | ✅ Primary (writes + point lookups) | ✅ Analytics copy (denormalized) |
| `judgments_jobs` | ✅ Primary | ❌ |
| `project_articles` | ✅ Primary | ❌ |

### Query Routing Strategy

| Query Type | Database | Notes |
|------------|----------|---------|
| **Analytics** (list, filter, aggregate) | ClickHouse | Fast aggregations via columnar storage |
| **Detail page** (single judgment by `id`) | PostgreSQL | Fast point lookup (B-tree PK), avoids scanning Parquet |
| **Writes** | PostgreSQL + Parquet | Dual-write: canonical row in Postgres, denormalized row in Parquet |

## Denormalized Judgment Schema

Each Parquet record contains fields needed for analytics and list views. Detail-only fields (e.g. `explanation`, `quotes`) stay in PostgreSQL for fast point lookups.

```typescript
interface DenormalizedJudgmentAnalytics {
  // Primary identifiers
  id: string
  createdAt: Date
  updatedAt: Date

  // Core judgment data
  articleId: string
  promptId: string
  modelId: string
  isAnswered: boolean
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null

  // Denormalized: Article fields
  articleTitle: string
  articleSummary: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleArxivId: string | null
  articleOpenalexId: string | null
  articleImportRoute: string | null
  articleDoi: string | null

  // Denormalized: Prompt fields
  promptHeading: string | null
  promptType: string | null
  promptContentHash: string | null

  // Denormalized: Project fields
  projectId: string
  projectName: string | null
  projectOwnerId: string | null
  projectUseTitle: boolean
  projectUseAbstract: boolean
  projectUseFulltext: boolean

  // Denormalized: Model fields
  modelName: string | null
  modelProvider: string | null
}
```

## Partitioning Strategy

```
/data/judgments/
├── year=2024/
│   ├── month=01/
│   │   ├── project=abc-123/
│   │   │   ├── part-1704067200000-a1b2c3d4.parquet
│   │   │   └── part-1704067210000-e5f6g7h8.parquet
│   │   └── project=def-456/
│   │       └── ...
└── ...
```

**Rationale:**
- **Immutability:** Each batch write creates a NEW file. No file locking or concurrency issues.
- `year/month/project`: Partitioning for efficient pruning.

---

# Implementation Checklist

## Phase 0: Denormalize PostgreSQL Judgments Table
(Temporary step to facilitate easy export and dual-write testing)

- [ ] Create a Drizzle migration (via Drizzle CLI) adding the denorm fields needed for Parquet analytics (no need to add `explanation`/`quotes` — they already exist in `judgments`).
- [ ] Create `scripts/backfill-denormalized-judgments.ts` to update existing rows.
- [ ] Update LLM Worker to write to these new columns.
- [ ] Validate data matches joined queries.

## Phase 1: ClickHouse & Parquet Infrastructure

### 1.1 ClickHouse Setup (Early Adoption)
- [ ] Add ClickHouse to `docker-compose.yml`
- [ ] Configure `config.xml` / `users.xml` for local access
- [ ] Verify connection from Node.js
- [ ] Map `/data/judgments/` volume to ClickHouse container

### 1.2 Parquet Writer Service
- [ ] Install `@dsnp/parquetjs`
- [ ] Create `src/services/parquet/types.ts` (Analytics Schema)
- [ ] Create `src/services/parquet/parquetWriter.ts`
  - [ ] Implement `writeBatch(partition, records)`
  - [ ] Use naming convention: `part-{timestamp}-{uuid}.parquet`
  - [ ] Compression: **Snappy** (ZSTD not supported by library)

### 1.3 Batch Buffer
- [ ] Create `src/services/parquet/judgmentBatcher.ts`
- [ ] Buffer judgments in memory
- [ ] Flush every X seconds or Y count
- [ ] Handle SIGTERM to flush remaining items

## Phase 2: Dual-Write & Export

### 2.1 Integration
- [ ] Modify LLM Worker: Write to Postgres (Safety) AND Parquet Batcher
- [ ] Ensure the Parquet record contains analytics/list fields; keep `explanation`/`quotes` in Postgres for detail page

### 2.2 Export History
- [ ] Create `scripts/export-judgments-to-parquet.ts`
- [ ] Read from denormalized Postgres table
- [ ] Write to seeded Parquet files (using 10k batch size)

## Phase 3: ClickHouse Integration

### 3.1 External Tables
- [ ] Define ClickHouse Schema matching Parquet
- [ ] Create View / External Table pointing to `/data/judgments/**/*.parquet`

### 3.2 API Layer Migration
- [ ] Install ClickHouse client for Node.js
- [ ] Refactor `/api/articlesreviews` to generate SQL and query ClickHouse
- [ ] Keep Detail Page querying Postgres by `id` (avoid Parquet scans)
- [ ] Verify performance

## Phase 4: Cleanup

### 4.1 Switch & Deprecate
- [ ] Make Parquet/ClickHouse the primary read path for analytics routes
- [ ] Keep `judgments` in Postgres for point lookups (detail page)
- [ ] (Optional) Remove denorm columns/indexes from Postgres once ClickHouse analytics is stable

---

## Performance Notes
- **Point Lookups:** ClickHouse/DuckDB over Parquet is not O(1); keep Postgres (or a K/V store) for `where id = ?` detail lookups.
- **Concurrency:** The `part-{timestamp}-{uuid}` strategy allows multiple workers to write simultaneously without locking.

## Open Questions
- [ ] Keep `judgments` as-is in Postgres, or split into a smaller `judgment_details` table keyed by `id`?
- [ ] S3/MinIO strategy for Production? (To be decided later)
