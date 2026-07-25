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
  is_answered BOOLEAN,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  judgment_created_at TIMESTAMPTZ,
  human_comment VARCHAR,
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
  is_answered,
  answered_original,
  answered_original_as_array,
  judgment_created_at,
  human_comment,
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
  is_answered,
  answered_original,
  answered_original_as_array,
  judgment_created_at,
  human_comment,
  placeholder_kind,
  detail_updated_at
FROM mart.review_article_judgment_detail_serving_v4;

DROP TABLE mart.review_article_judgment_detail_serving_v4;

ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_repaired_pk
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_payload_identity
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);

DROP INDEX IF EXISTS mart.idx_review_article_judgment_detail_hydration_serving_v4_article;
DROP INDEX IF EXISTS idx_review_article_judgment_detail_hydration_serving_v4_article;
DROP INDEX IF EXISTS mart.idx_review_article_judgment_detail_hydration_serving_v4_payload_identity;
DROP INDEX IF EXISTS idx_review_article_judgment_detail_hydration_serving_v4_payload_identity;
DROP INDEX IF EXISTS mart.idx_review_article_judgment_detail_hydration_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_article_judgment_detail_hydration_serving_v4_repaired_pk;
DROP TABLE IF EXISTS mart.review_article_judgment_detail_hydration_serving_v4;
