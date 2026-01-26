-- Run only if you already have `forska.judgments` as a TABLE (legacy).
-- Goal: keep legacy data (rename), then create the PeerDB-era VIEW.

SELECT database, name, engine
FROM system.tables
WHERE database = 'forska' AND name IN ('judgments', 'judgments_raw');

-- If engine != 'View', rename the legacy table (pick any name)
RENAME TABLE forska.judgments TO forska.judgments_legacy;

-- Create/refresh the PeerDB-era sink + view (safe to re-run)
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
    snapshot_project_id Nullable(String),
    snapshot_project_model_name Nullable(String),

    INDEX idx_judgments_raw_id id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (article_id, prompt_id, model_id, id);

DROP VIEW IF EXISTS forska.judgments;
CREATE VIEW forska.judgments AS
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
    j.quotes
FROM forska.judgments_raw j
LEFT JOIN forska.articles a ON j.article_id = a.id
WHERE j.deleted_at IS NULL;

