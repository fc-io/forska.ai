-- ClickHouse DDL for Forska Judgments Analytics
-- Run against forska database

CREATE DATABASE IF NOT EXISTS forska;

-- ============================================================
-- 1. MAIN ANALYTICS TABLE: live-only (no tombstones)
-- ============================================================
CREATE TABLE IF NOT EXISTS forska.judgments (
    id String,
    createdAt DateTime64(3, 'UTC'),
    updatedAt DateTime64(3, 'UTC'),
    articleId String,
    articleTitle String,
    articleCreatedAt Nullable(DateTime64(3, 'UTC')),
    articleUpdatedAt Nullable(DateTime64(3, 'UTC')),
    articleCreatedYear Nullable(Int32),
    articleUpdatedYear Nullable(Int32),
    articleImportRoute Nullable(String),
    articleImportedBy Nullable(String),
    promptId String,
    modelId String,
    useTitle Bool DEFAULT true,
    useAbstract Bool DEFAULT true,
    useFulltext Bool DEFAULT false,
    useFulltextNoImages Bool DEFAULT false,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(Nullable(String)) DEFAULT [],
    explanation Nullable(String),
    quotes Array(String) DEFAULT [],
    INDEX idx_judgments_id id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(createdAt)
ORDER BY (articleId, promptId, modelId, id);

-- ============================================================
-- 2. ARTICLES TABLE: ReplacingMergeTree (workaround for MaterializedPostgreSQL)
-- ============================================================
CREATE TABLE IF NOT EXISTS forska.articles (
    id String,

    created_at DateTime64(6, 'UTC'),
    updated_at DateTime64(6, 'UTC'),

    article_title String,
    article_created_at Nullable(DateTime64(6, 'UTC')),
    article_updated_at Nullable(DateTime64(6, 'UTC')),
    article_id Nullable(String),
    article_summary Nullable(String),
    article_version Nullable(Int32),
    arxiv_id Nullable(String),
    doi Nullable(String),
    pubmed_id Nullable(String),
    url Nullable(String),
    content_hash Nullable(String),
    import_route Nullable(String),
    imported_by Nullable(String),
    publication_status Nullable(String),

    full_text Nullable(String),
    full_text_source Nullable(String),
    full_text_original_format Nullable(String),
    full_text_pdf Nullable(String),
    full_text_fetched_at Nullable(DateTime64(6, 'UTC')),

    openalex_id Nullable(String),
    biorxiv_id Nullable(String),
    medrxiv_id Nullable(String),

    full_text_conversion_status Nullable(String),
    full_text_conversion_error Nullable(String),
    full_text_conversion_attempts Nullable(Int32),
    full_text_char_count Nullable(Int32),
    full_text_html Nullable(String),
    full_text_pdf_uploaded_by Nullable(String)
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (id);

-- ============================================================
-- 3. ARTICLES STATS: Aggregated counts for health checks
-- ============================================================
CREATE TABLE IF NOT EXISTS forska.articles_stats (
    month UInt32,
    uniqueCount AggregateFunction(uniqCombined64, UInt64),
    maxUpdatedAt AggregateFunction(max, DateTime64(6, 'UTC'))
) ENGINE = AggregatingMergeTree()
PARTITION BY month
ORDER BY month;

CREATE MATERIALIZED VIEW IF NOT EXISTS forska.articles_stats_mv
TO forska.articles_stats
AS
SELECT
    toYYYYMM(created_at) as month,
    uniqCombined64State(cityHash64(id)) as uniqueCount,
    maxState(updated_at) as maxUpdatedAt
FROM forska.articles
GROUP BY month;
