-- ClickHouse DDL for Forska Judgments Analytics
-- Run against forska database

-- ============================================================
-- 1. MAIN ANALYTICS TABLE: ReplacingMergeTree for deduplication
-- ============================================================
-- Note: We use createdAt as the version column since deletedAt can be NULL
-- Tombstones (soft deletes) are handled via WHERE deletedAt IS NULL in queries
CREATE TABLE IF NOT EXISTS forska.judgments (
    id String,
    createdAt DateTime64(6, 'UTC'),
    deletedAt Nullable(DateTime64(6, 'UTC')),
    articleId String,
    articleTitle String,
    articleCreatedAt Nullable(DateTime64(6, 'UTC')),
    articleUpdatedAt Nullable(DateTime64(6, 'UTC')),
    articleCreatedYear Nullable(Int32),
    articleUpdatedYear Nullable(Int32),
    articleImportRoute Nullable(String),
    articleImportedBy Nullable(String),
    promptId String,
    modelId String,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(Nullable(String)),
    explanation Nullable(String),
    quotes Nullable(String)
) ENGINE = ReplacingMergeTree(createdAt)
PARTITION BY toYYYYMM(createdAt)
ORDER BY (id);

-- ============================================================
-- 2. SOURCE TABLE: S3Queue ingests new Parquet files
-- ============================================================
-- Uses Nullable types to match Parquet schema exactly
-- Keeper is required for S3Queue (file processing checkpoints)
CREATE TABLE IF NOT EXISTS forska.judgments_queue (
    id Nullable(String),
    createdAt Nullable(DateTime64(6, 'UTC')),
    deletedAt Nullable(DateTime64(6, 'UTC')),
    articleId Nullable(String),
    articleTitle Nullable(String),
    articleCreatedAt Nullable(DateTime64(6, 'UTC')),
    articleUpdatedAt Nullable(DateTime64(6, 'UTC')),
    articleCreatedYear Nullable(Int32),
    articleUpdatedYear Nullable(Int32),
    articleImportRoute Nullable(String),
    articleImportedBy Nullable(String),
    promptId Nullable(String),
    modelId Nullable(String),
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(Nullable(String)),
    explanation Nullable(String),
    quotes Nullable(String)
) ENGINE = S3Queue(
    'http://seaweedfs:8333/forska-judgments/judgments/**/*.parquet',
    'admin',
    'admin',
    'Parquet'
)
SETTINGS
    mode = 'ordered',
    s3queue_processing_threads_num = 4;

-- ============================================================
-- 3. MATERIALIZED VIEW: Route from Queue to Main Table
-- ============================================================
-- Converts Nullable fields to non-nullable where needed using coalesce
CREATE MATERIALIZED VIEW IF NOT EXISTS forska.judgments_mv TO forska.judgments AS
SELECT
    coalesce(id, '') AS id,
    coalesce(createdAt, now64(6)) AS createdAt,
    deletedAt,
    coalesce(articleId, '') AS articleId,
    coalesce(articleTitle, '') AS articleTitle,
    articleCreatedAt,
    articleUpdatedAt,
    articleCreatedYear,
    articleUpdatedYear,
    articleImportRoute,
    articleImportedBy,
    coalesce(promptId, '') AS promptId,
    coalesce(modelId, '') AS modelId,
    answeredOriginal,
    answeredOriginalAsArray,
    explanation,
    quotes
FROM forska.judgments_queue;
