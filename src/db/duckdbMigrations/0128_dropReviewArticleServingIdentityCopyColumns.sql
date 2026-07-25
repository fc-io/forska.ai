DROP TABLE IF EXISTS mart.review_article_serving_v4_repair;

CREATE TABLE mart.review_article_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL,
  patch_watermark BIGINT NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  sort_key TIMESTAMPTZ NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  llm_status_key VARCHAR,
  human_status_key VARCHAR,
  llm_judged_prompt_count INTEGER NOT NULL DEFAULT 0,
  enabled_prompt_count INTEGER NOT NULL DEFAULT 0,
  human_answered_prompt_count INTEGER NOT NULL DEFAULT 0,
  serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0),
  CHECK (llm_judged_prompt_count >= 0),
  CHECK (enabled_prompt_count >= 0),
  CHECK (human_answered_prompt_count >= 0)
);

INSERT INTO mart.review_article_serving_v4_repair
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  base_generation,
  patch_watermark,
  list_mode_key,
  article_id,
  article_created_at,
  sort_key,
  activity_sort_at,
  llm_status_key,
  human_status_key,
  llm_judged_prompt_count,
  enabled_prompt_count,
  human_answered_prompt_count,
  serving_updated_at
FROM mart.review_article_serving_v4;

DROP TABLE mart.review_article_serving_v4;

ALTER TABLE mart.review_article_serving_v4_repair RENAME TO review_article_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_v4_repaired_pk
ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_v4_order
ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, sort_key, article_id);
