-- ClickHouse Migration: Add Content Settings Columns
-- Run this script to add useTitle, useAbstract, useFulltext, useFulltextNoImages columns
-- to existing ClickHouse tables.
--
-- Default values match the legacy behavior where title + abstract was assumed.
--
-- Usage:
--   clickhouse-client --database forska < scripts/clickhouse-add-content-settings.sql
--
-- Or in Docker:
--   docker exec -i clickhouse clickhouse-client --database forska < scripts/clickhouse-add-content-settings.sql

-- ============================================================
-- 1. Add columns to main analytics table
-- ============================================================
ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS useTitle Bool DEFAULT true;
ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS useAbstract Bool DEFAULT true;
ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS useFulltext Bool DEFAULT false;
ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS useFulltextNoImages Bool DEFAULT false;

-- ============================================================
-- 2. Recreate S3Queue source table with new columns
-- ============================================================
-- S3Queue tables don't support ALTER TABLE, so we must drop and recreate
-- First drop the materialized view that depends on it
DROP VIEW IF EXISTS forska.judgments_mv;

-- Now drop and recreate the queue table with new columns
DROP TABLE IF EXISTS forska.judgments_queue;

CREATE TABLE forska.judgments_queue (
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
    useTitle Nullable(Bool),
    useAbstract Nullable(Bool),
    useFulltext Nullable(Bool),
    useFulltextNoImages Nullable(Bool),
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
-- 3. Recreate materialized view with new columns
-- ============================================================
CREATE MATERIALIZED VIEW forska.judgments_mv TO forska.judgments AS
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
    coalesce(useTitle, true) AS useTitle,
    coalesce(useAbstract, true) AS useAbstract,
    coalesce(useFulltext, false) AS useFulltext,
    coalesce(useFulltextNoImages, false) AS useFulltextNoImages,
    answeredOriginal,
    answeredOriginalAsArray,
    explanation,
    quotes
FROM forska.judgments_queue;

-- ============================================================
-- 4. Verify columns exist
-- ============================================================
SELECT 'Columns added successfully. Verifying schema...' AS status;

SELECT name, type, default_expression
FROM system.columns
WHERE table = 'judgments' AND database = 'forska' AND name LIKE 'use%'
ORDER BY name;
