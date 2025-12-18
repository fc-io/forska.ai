# ClickHouse + Parquet Migration Plan

> **Goal**: Migrate judgments storage from PostgreSQL to a Parquet-first architecture with ClickHouse as the query engine for analytics AND detail lookups.

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
3. Build denormalized record (including explanation/quotes)
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
7. API returns results
```

## Database Responsibilities

| Table | PostgreSQL | Parquet/ClickHouse |
|-------|------------|-------------------|
| `users`, `sessions` | ✅ Primary | ❌ |
| `projects` | ✅ Primary | ❌ |
| `prompts` | ✅ Primary | ❌ |
| `articles` | ✅ Primary | Denormalized copy in judgments |
| `judgments` | ❌ Audit/Backup only | ✅ Primary for analytics AND details |
| `judgments_jobs` | ✅ Primary | ❌ |
| `project_articles` | ✅ Primary | ❌ |

### Query Routing Strategy

| Query Type | Database | Notes |
|------------|----------|---------|
| **Analytics** (list, filter, aggregate) | ClickHouse | Fast aggregations via columnar storage |
| **Detail page** (single judgment) | ClickHouse | ClickHouse handles point lookups well with proper keys |
| **Writes** | PostgreSQL → Parquet | LLM judgment creation writes to Parquet |

## Denormalized Judgment Schema

Each Parquet record contains ALL fields needed for both analytics and detail views.

```typescript
interface DenormalizedJudgment {
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

  // "Heavy" data (now included based on request)
  explanation: string | null
  quotes: string | null // JSON string or Array<string>
  confidenceOriginal: number | null

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
  promptOriginalText: string | null // Optional if needed for display without join

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

- [ ] Create migration: `src/db/migrations/00XX_denormalize_judgments.sql` adding all denorm fields + `explanation`/`quotes`.
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
- [ ] Create `src/services/parquet/types.ts` (Full Schema)
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
- [ ] Ensure `explanation` and `quotes` are written to Parquet

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
- [ ] Refactor Detail Page to query ClickHouse by ID (benchmarking required)
- [ ] Verify performance

## Phase 4: Cleanup

### 4.1 Switch & Deprecate
- [ ] Make Parquet path the primary Read path
- [ ] Remove `judgments` table dependency
- [ ] (Optional) Retain `judgments` table as "Write-Only" audit log for a few weeks
- [ ] Finally drop Postgres `judgments` table

---

## Performance Notes
- **Point Lookups:** ClickHouse is not a K-V store, but with the right Primary Key (e.g. `id`), lookups for a single judgment among 100M rows should still be under 20-50ms, which is acceptable for a detail page.
- **Concurrency:** The `part-{timestamp}-{uuid}` strategy allows multiple workers to write simultaneously without locking.

## Open Questions
- [ ] ClickHouse Primary Key definition for optimal `where id = ?` performance?
- [ ] S3/MinIO strategy for Production? (To be decided later)
