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
  prompt_original_text VARCHAR,
  prompt_heading VARCHAR,
  prompt_type VARCHAR,
  prompt_criteria_disposition project_prompt_criteria_disposition_v2,
  judgment_created_at TIMESTAMPTZ,
  judgment_updated_at TIMESTAMPTZ,
  human_comment VARCHAR,
  explanation VARCHAR,
  quotes JSON,
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
  prompt_original_text,
  prompt_heading,
  prompt_type,
  prompt_criteria_disposition,
  judgment_created_at,
  judgment_updated_at,
  human_comment,
  explanation,
  quotes,
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
  placeholder_kind,
  detail_updated_at
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
  prompt_original_text,
  prompt_heading,
  prompt_type,
  prompt_criteria_disposition,
  judgment_created_at,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN TRY_CAST(json_extract_string(judgment_payload_json, '$.updatedAt') AS TIMESTAMPTZ)
    ELSE detail_updated_at
  END AS judgment_updated_at,
  human_comment,
  explanation,
  quotes,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.chunkingStrategy')
    ELSE NULL
  END AS chunking_strategy,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN TRY_CAST(json_extract_string(judgment_payload_json, '$.confidenceOriginal') AS DOUBLE)
    ELSE NULL
  END AS confidence_original,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.snapshotProjectId')
    ELSE NULL
  END AS snapshot_project_id,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.snapshotProjectModelName')
    ELSE NULL
  END AS snapshot_project_model_name,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.model.name')
    ELSE NULL
  END AS model_name,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.model.provider')
    ELSE NULL
  END AS model_provider,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.model.thinking')
    ELSE NULL
  END AS model_thinking,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.model.version')
    ELSE NULL
  END AS model_version,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.assessments[0].id')
    ELSE NULL
  END AS assessment_id,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.assessments[0].judgmentId')
    ELSE NULL
  END AS assessment_judgment_id,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL
      THEN TRY_CAST(json_extract_string(judgment_payload_json, '$.assessments[0].assessmentIsCorrect') AS BOOLEAN)
    ELSE NULL
  END AS assessment_is_correct,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.assessments[0].assessmentComment')
    ELSE NULL
  END AS assessment_comment,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL
      THEN TRY_CAST(json_extract_string(judgment_payload_json, '$.assessments[0].createdAt') AS TIMESTAMPTZ)
    ELSE NULL
  END AS assessment_created_at,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL
      THEN TRY_CAST(json_extract_string(judgment_payload_json, '$.assessments[0].updatedAt') AS TIMESTAMPTZ)
    ELSE NULL
  END AS assessment_updated_at,
  placeholder_kind,
  detail_updated_at
FROM mart.review_article_judgment_detail_serving_v4;

DROP TABLE mart.review_article_judgment_detail_serving_v4;

ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_repaired_pk
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);
