# ClickHouse + Parquet Migration Plan

> **Goal**: Migrate judgments analytics from PostgreSQL to a Parquet-first architecture with ClickHouse as the query engine, while keeping PostgreSQL (or another K/V store) for fast judgment `id` lookups (detail page).

## Architecture Overview (Parquet-First)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Application                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   WRITE PATH (The "Source of Truth")   READ PATH                         │
│   ──────────────────────────────────   ─────────                         │
│                                                                          │
│   LLM Worker                                                             │
│       │                                                                  │
│       ▼                                                                  │
│   ┌────────────┐                      ┌────────────┐ (Analytics)        │
│   │  Parquet   │─────  write   ──────▶│ ClickHouse │                    │
│   │  Writer    │                      │  (Query)   │                    │
│   └────────────┘                      └────────────┘                    │
│        │                                    ▲                           │
│        │ writes                             │ reads (external table)    │
│        ▼                                    │                           │
│   ┌───────────────────────────────┐         │                           │
│   │        Parquet Files          │─────────┘                           │
│   │      (System of Record)       │                                     │
│   └───────────────────────────────┘                                     │
│        │                                                                │
│        │ (Tail / Watch)                                                 │
│        ▼                                                                │
│   ┌────────────┐                      ┌────────────┐ (Detail View)      │
│   │   Sync     │ via UPSERT           │ PostgreSQL │                    │
│   │  Service   │─────────────────────▶│  (Cache)   │                    │
│   └────────────┘                      └────────────┘                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Design Decisions

### 1. Parquet as Source of Truth
**Decision**: The canonical record of a judgment is the Parquet file. PostgreSQL is treated as a downstream "materialized view" used only for serving specific UI needs (like `ById` lookups) that are inefficient in columnar stores.
- **Benefit**: Decouples the core data asset from the operational database.
- **Tradeoff**: **Eventual Consistency**. There will be a slight delay (seconds) between a judgment being written and it appearing in the PostgreSQL-backed Detail page.

### 2. Immutability & Updates
**Decision**: Parquet files are strictly **immutable**.
- **Updates**: An updated judgment is written as a **new row** in a **new file** with a newer timestamp.
- **Consolidation**: Both ClickHouse (via `ReplacingMergeTree`) and the Postgres Sync Service must handle deduplication by always taking the record with the latest `updatedAt`.

### 3. Partitioning Strategy
**Decision**: Partition strictly by time.
- **Structure**: `/data/judgments/year=YYYY/month=MM/ulid-{timestamp}.parquet`
- **Naming**: Using `ulid` implies time-sorting, helping with compaction later.

## Sync Strategy: The "Parquet Tailer"

To keep PostgreSQL in sync for the Detail View, we implement a **Tailer Service**.

1.  **Watch**: The service monitors `/data/judgments/**` for new files.
2.  **Read**: It opens new Parquet files and reads the batch of records.
3.  **Upsert**: It performs a bulk `INSERT ... ON CONFLICT (id) DO UPDATE` into PostgreSQL.
    *   *Constraint*: Only update if the incoming `updatedAt` > existing `updatedAt` (to handle out-of-order processing).

## Database Responsibilities

| Table | PostgreSQL | Parquet (File System) |
|-------|------------|-------------------|
| `users`, `projects` | ✅ Primary | ❌ |
| `articles` | ✅ Primary | Denormalized copy in `judgments` |
| `judgments` | ⚠️ **Read Replica** (for ID lookup) | ✅ **Primary Source of Truth** |

## Denormalized Judgment Schema (for Analytics)

This schema represents the flat record written to Parquet.

```typescript
interface DenormalizedJudgmentAnalytics {
  // Primary identifiers (Used for Collapsing/Deduplication)
  id: string
  updatedAt: Date // Critical: Used as version/sorting key

  // Analytic Dimensions
  createdAt: Date
  projectId: string
  projectName: string
  articleId: string
  articleTitle: string
  articleImportRoute: string | null
  promptId: string
  promptHeading: string | null
  modelId: string
  modelName: string | null

  // Metrics
  isAnswered: boolean
  answeredOriginal: string | null
  // Note: All fields, including large text like 'explanation', are in Parquet now
  // since it is the Source of Truth.
  explanation: string | null
  quotes: string | null // serialized JSON
}
```

---

# Implementation Checklist

## Phase 1: Parquet Writer & "Tailer" (The Core)
This effectively builds the new storage engine first.

- [ ] **Data Structure**: Define the `DenormalizedJudgment` schema (TypeScript interface).
- [ ] **Parquet Writer**: Create `src/services/parquet/parquetWriter.ts`.
  - [ ] Implement `writeBatch(judgments)` to `/data/judgments/YYYY/MM/...`.
  - [ ] Implement a buffer/flush mechanism (flush every 5s or 100 items) to avoid creating 1 file per judgment.
- [ ] **Sync Service ("Tailer")**: Create `src/services/sync/parquetTailer.ts`.
  - [ ] Use `chokidar` or polling to detect new files.
  - [ ] Implement `syncFileToPostgres(filePath)`: Reads Parquet -> Upserts to Postgres `judgments`.
  - [ ] **Migration**: Add the denormalized columns to Postgres table now (Phase 0 logic is still needed for the destination table to match the source).

## Phase 2: Switch Write Path
- [ ] **LLM Worker**: Modify the worker to call `ParquetWriter.write()` instead of `db.insert(judgments)`.
  - [Note]: The worker currently does the JOINs to get article/project data. It will now package that into the `DenormalizedJudgment` object.

## Phase 3: ClickHouse Integration
- [ ] **Infrastructure**: Add ClickHouse to `docker-compose`.
- [ ] **DDL**: Create `judgments_local` (`ReplacingMergeTree`) pointing to the data path or using `S3Queue` / `Directory` engine.

## Phase 4: Backfill (Legacy Data)
- [ ] **Script**: Create `scripts/legacy-postgres-to-parquet.ts`.
  - [ ] Reads current Postgres rows.
  - [ ] Writes them to Parquet (archived partitions).
  - [ ] This ensures Parquet has 100% of history.

## Open Questions
- [ ] Is `fs.watch` reliable enough for production "Tailing" or do we need a dedicated log-shipping daemon?
