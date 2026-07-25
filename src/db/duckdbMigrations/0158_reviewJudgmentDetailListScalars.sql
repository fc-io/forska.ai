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
  human_comment VARCHAR,
  explanation VARCHAR,
  quotes JSON,
  judgment_payload_json JSON,
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
  human_comment,
  explanation,
  quotes,
  judgment_payload_json,
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
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.model.id')
    ELSE NULL
  END AS judgment_model_id,
  is_answered,
  answered_original,
  answered_original_as_array,
  prompt_original_text,
  prompt_heading,
  prompt_type,
  prompt_criteria_disposition,
  judgment_created_at,
  human_comment,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract_string(judgment_payload_json, '$.explanation')
    ELSE NULL
  END AS explanation,
  CASE
    WHEN payload_kind = 'llm' AND placeholder_kind IS NULL THEN json_extract(judgment_payload_json, '$.quotes')
    ELSE NULL
  END AS quotes,
  judgment_payload_json,
  placeholder_kind,
  detail_updated_at
FROM mart.review_article_judgment_detail_serving_v4;

DROP TABLE mart.review_article_judgment_detail_serving_v4;

ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_repaired_pk
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);
