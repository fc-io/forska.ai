DROP TABLE IF EXISTS mart.review_article_judgment_detail_serving_v4_repair;

CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  payload_kind VARCHAR NOT NULL DEFAULT 'llm',
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  prompt_order INTEGER,
  judgment_id VARCHAR,
  judgment_model_id VARCHAR,
  is_answered BOOLEAN,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  judgment_created_at TIMESTAMPTZ,
  human_comment VARCHAR,
  explanation VARCHAR,
  quotes JSON,
  placeholder_kind VARCHAR,
  detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_article_judgment_detail_serving_v4_repair (
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  payload_kind,
  article_id,
  prompt_id,
  prompt_order,
  judgment_id,
  judgment_model_id,
  is_answered,
  answered_original,
  answered_original_as_array,
  judgment_created_at,
  human_comment,
  explanation,
  quotes,
  placeholder_kind,
  detail_updated_at
)
WITH normalized AS (
  SELECT
    project_id,
    review_config_hash,
    snapshot_id,
    CASE
      WHEN payload_kind = 'human' THEN 'human'
      WHEN payload_kind = 'llm' THEN 'llm'
      ELSE list_mode_key
    END AS list_mode_key,
    payload_kind,
    article_id,
    prompt_id,
    prompt_order,
    judgment_id,
    judgment_model_id,
    is_answered,
    answered_original,
    answered_original_as_array,
    judgment_created_at,
    human_comment,
    explanation,
    quotes,
    placeholder_kind,
    detail_updated_at,
    row_number() OVER (
      PARTITION BY project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id
      ORDER BY
        CASE
          WHEN payload_kind = 'human' AND list_mode_key = 'human' THEN 0
          WHEN payload_kind = 'llm' AND list_mode_key = 'llm' THEN 0
          WHEN list_mode_key = 'both' THEN 1
          ELSE 2
        END,
        detail_updated_at DESC NULLS LAST
    ) AS row_rank
  FROM mart.review_article_judgment_detail_serving_v4
)
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  payload_kind,
  article_id,
  prompt_id,
  prompt_order,
  judgment_id,
  judgment_model_id,
  is_answered,
  answered_original,
  answered_original_as_array,
  judgment_created_at,
  human_comment,
  explanation,
  quotes,
  placeholder_kind,
  detail_updated_at
FROM normalized
WHERE row_rank = 1;

DROP TABLE mart.review_article_judgment_detail_serving_v4;

ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_repaired_pk
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_payload_identity
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);

DROP TABLE IF EXISTS mart.review_article_judgment_detail_hydration_serving_v4_repair;

CREATE TABLE mart.review_article_judgment_detail_hydration_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  payload_kind VARCHAR NOT NULL DEFAULT 'llm',
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  judgment_updated_at TIMESTAMPTZ,
  chunking_strategy VARCHAR,
  confidence_original DOUBLE,
  snapshot_project_id VARCHAR,
  snapshot_project_model_name VARCHAR,
  model_name VARCHAR,
  model_provider VARCHAR,
  model_thinking VARCHAR,
  model_version VARCHAR,
  assessment_id VARCHAR,
  assessment_judgment_id VARCHAR,
  assessment_is_correct BOOLEAN,
  assessment_comment VARCHAR,
  assessment_created_at TIMESTAMPTZ,
  assessment_updated_at TIMESTAMPTZ,
  detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_article_judgment_detail_hydration_serving_v4_repair (
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  payload_kind,
  article_id,
  prompt_id,
  judgment_updated_at,
  chunking_strategy,
  confidence_original,
  snapshot_project_id,
  snapshot_project_model_name,
  model_name,
  model_provider,
  model_thinking,
  model_version,
  assessment_id,
  assessment_judgment_id,
  assessment_is_correct,
  assessment_comment,
  assessment_created_at,
  assessment_updated_at,
  detail_updated_at
)
WITH normalized AS (
  SELECT
    project_id,
    review_config_hash,
    snapshot_id,
    CASE
      WHEN payload_kind = 'human' THEN 'human'
      WHEN payload_kind = 'llm' THEN 'llm'
      ELSE list_mode_key
    END AS list_mode_key,
    payload_kind,
    article_id,
    prompt_id,
    judgment_updated_at,
    chunking_strategy,
    confidence_original,
    snapshot_project_id,
    snapshot_project_model_name,
    model_name,
    model_provider,
    model_thinking,
    model_version,
    assessment_id,
    assessment_judgment_id,
    assessment_is_correct,
    assessment_comment,
    assessment_created_at,
    assessment_updated_at,
    detail_updated_at,
    row_number() OVER (
      PARTITION BY project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id
      ORDER BY
        CASE
          WHEN payload_kind = 'human' AND list_mode_key = 'human' THEN 0
          WHEN payload_kind = 'llm' AND list_mode_key = 'llm' THEN 0
          WHEN list_mode_key = 'both' THEN 1
          ELSE 2
        END,
        detail_updated_at DESC NULLS LAST
    ) AS row_rank
  FROM mart.review_article_judgment_detail_hydration_serving_v4
)
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  payload_kind,
  article_id,
  prompt_id,
  judgment_updated_at,
  chunking_strategy,
  confidence_original,
  snapshot_project_id,
  snapshot_project_model_name,
  model_name,
  model_provider,
  model_thinking,
  model_version,
  assessment_id,
  assessment_judgment_id,
  assessment_is_correct,
  assessment_comment,
  assessment_created_at,
  assessment_updated_at,
  detail_updated_at
FROM normalized
WHERE row_rank = 1;

DROP TABLE mart.review_article_judgment_detail_hydration_serving_v4;

ALTER TABLE mart.review_article_judgment_detail_hydration_serving_v4_repair RENAME TO review_article_judgment_detail_hydration_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_hydration_serving_v4_repaired_pk
ON mart.review_article_judgment_detail_hydration_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_hydration_serving_v4_payload_identity
ON mart.review_article_judgment_detail_hydration_serving_v4(project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_hydration_serving_v4_article
ON mart.review_article_judgment_detail_hydration_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind);
