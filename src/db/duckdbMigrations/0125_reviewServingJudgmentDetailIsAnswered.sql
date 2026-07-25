DROP TABLE IF EXISTS mart.review_article_judgment_detail_serving_v4_is_answered_next;

CREATE TABLE mart.review_article_judgment_detail_serving_v4_is_answered_next (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  payload_kind VARCHAR NOT NULL DEFAULT 'llm',
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  prompt_order INTEGER,
  judgment_id VARCHAR,
  model_id VARCHAR,
  is_answered BOOLEAN,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  judgment_payload_json JSON,
  placeholder_kind VARCHAR,
  detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)
);

INSERT INTO mart.review_article_judgment_detail_serving_v4_is_answered_next (
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  payload_kind,
  article_id,
  prompt_id,
  prompt_order,
  judgment_id,
  model_id,
  is_answered,
  answered_original,
  answered_original_as_array,
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
  model_id,
  COALESCE(
    TRY_CAST(json_extract_string(judgment_payload_json, '$.isAnswered') AS BOOLEAN),
    answered_original IS NOT NULL,
    FALSE
  ) AS is_answered,
  answered_original,
  answered_original_as_array,
  judgment_payload_json,
  placeholder_kind,
  detail_updated_at
FROM mart.review_article_judgment_detail_serving_v4;

DROP TABLE mart.review_article_judgment_detail_serving_v4;

ALTER TABLE mart.review_article_judgment_detail_serving_v4_is_answered_next
RENAME TO review_article_judgment_detail_serving_v4;

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);
