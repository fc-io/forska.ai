-- ClickHouse DDL for PeerDB PG→CH replication + app query layer (peerdb metadata + ReplacingMergeTree)

CREATE DATABASE IF NOT EXISTS forska;

-- ============================================================
-- 1. ARTICLES (PeerDB target)
-- ============================================================
CREATE TABLE IF NOT EXISTS forska.articles (
    id String,

    created_at DateTime64(6, 'UTC'),
    updated_at DateTime64(6, 'UTC'),

    article_title String,
    article_authors Array(Nullable(String)) DEFAULT [],
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
    full_text_assets Nullable(String),

    openalex_id Nullable(String),
    biorxiv_id Nullable(String),
    medrxiv_id Nullable(String),

    full_text_conversion_status Nullable(String),
    full_text_conversion_error Nullable(String),
    full_text_conversion_attempts Nullable(Int32),
    full_text_char_count Nullable(Int32),
    full_text_html Nullable(String),
    full_text_pdf_uploaded_by Nullable(String),

    original_data Nullable(String),

    _peerdb_version Int64,
    _peerdb_is_deleted Int8 DEFAULT 0,
    _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9)
) ENGINE = ReplacingMergeTree(_peerdb_version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (id);

-- ============================================================
-- 2. JUDGMENTS RAW (PeerDB target)
-- ============================================================
CREATE TABLE IF NOT EXISTS forska.judgments_raw (
    id String,
    created_at DateTime64(3, 'UTC'),
    updated_at DateTime64(3, 'UTC'),
    deleted_at Nullable(DateTime64(3, 'UTC')),

    article_id String,
    model_id String,
    prompt_id String,
    project_id Nullable(String),

    use_title Bool DEFAULT true,
    use_abstract Bool DEFAULT true,
    use_fulltext Bool DEFAULT false,
    use_fulltext_no_images Bool DEFAULT false,

    is_answered Nullable(Bool),
    answered_original Nullable(String),
    answered_original_as_array Array(Nullable(String)) DEFAULT [],
    confidence_original Nullable(Int32),
    explanation Nullable(String),
    quotes Nullable(String),
    snapshot_project_id Nullable(UUID),
    snapshot_project_model_name Nullable(String),

    _peerdb_version Int64,
    _peerdb_is_deleted Int8 DEFAULT 0,
    _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9),

    INDEX idx_judgments_raw_id id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = ReplacingMergeTree(_peerdb_version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (article_id, prompt_id, model_id, id);

-- ============================================================
-- 3. JUDGMENTS (denormalized table + MV for app queries)
-- ============================================================
CREATE TABLE IF NOT EXISTS forska.judgments (
    id String,
    createdAt DateTime64(3, 'UTC'),
    updatedAt DateTime64(3, 'UTC'),
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
    useTitle Bool DEFAULT true,
    useAbstract Bool DEFAULT true,
    useFulltext Bool DEFAULT false,
    useFulltextNoImages Bool DEFAULT false,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(Nullable(String)) DEFAULT [],
    explanation Nullable(String),
    quotes Nullable(String),
    _peerdb_version Int64,
    _peerdb_is_deleted Int8 DEFAULT 0,
    _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9),
    INDEX idx_judgments_id id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = ReplacingMergeTree(_peerdb_version)
PARTITION BY toYYYYMM(createdAt)
ORDER BY (articleId, promptId, modelId, id);

DROP TABLE IF EXISTS forska.judgments_mv;
CREATE MATERIALIZED VIEW IF NOT EXISTS forska.judgments_mv
TO forska.judgments
AS
SELECT
    j.id,
    j.created_at AS createdAt,
    j.updated_at AS updatedAt,
    j.article_id AS articleId,
    COALESCE(a.article_title, '') AS articleTitle,
    a.article_created_at AS articleCreatedAt,
    a.article_updated_at AS articleUpdatedAt,
    if(isNull(a.article_created_at), NULL, toInt32(toYear(a.article_created_at))) AS articleCreatedYear,
    if(isNull(a.article_updated_at), NULL, toInt32(toYear(a.article_updated_at))) AS articleUpdatedYear,
    a.import_route AS articleImportRoute,
    a.imported_by AS articleImportedBy,
    j.prompt_id AS promptId,
    j.model_id AS modelId,
    j.use_title AS useTitle,
    j.use_abstract AS useAbstract,
    j.use_fulltext AS useFulltext,
    j.use_fulltext_no_images AS useFulltextNoImages,
    j.answered_original AS answeredOriginal,
    j.answered_original_as_array AS answeredOriginalAsArray,
    j.explanation,
    j.quotes,
    j._peerdb_version AS _peerdb_version,
    if(j._peerdb_is_deleted = 1 OR isNotNull(j.deleted_at), 1, 0) AS _peerdb_is_deleted
FROM forska.judgments_raw j
ANY LEFT JOIN forska.articles a ON j.article_id = a.id AND a._peerdb_is_deleted = 0;

-- ============================================================
-- 4. ARTICLES STATS (health checks)
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
