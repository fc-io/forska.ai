DROP INDEX IF EXISTS mart.idx_review_article_serving_list_mode_state_v4_pk;
DROP INDEX IF EXISTS idx_review_article_serving_list_mode_state_v4_pk;
DROP TABLE IF EXISTS mart.review_article_serving_list_mode_state_v4_repair;

CREATE TABLE mart.review_article_serving_list_mode_state_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  has_llm_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
  has_human_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
  has_both_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
  has_unassessed_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
  llm_patch_watermark BIGINT,
  human_patch_watermark BIGINT,
  both_patch_watermark BIGINT,
  unassessed_patch_watermark BIGINT,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
  llm_status VARCHAR,
  human_status VARCHAR,
  llm_has_judgment BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (llm_patch_watermark IS NULL OR llm_patch_watermark >= 0),
  CHECK (human_patch_watermark IS NULL OR human_patch_watermark >= 0),
  CHECK (both_patch_watermark IS NULL OR both_patch_watermark >= 0),
  CHECK (unassessed_patch_watermark IS NULL OR unassessed_patch_watermark >= 0)
);

INSERT INTO mart.review_article_serving_list_mode_state_v4_repair
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  article_id,
  COALESCE(has_llm_list_mode, FALSE) AS has_llm_list_mode,
  COALESCE(has_human_list_mode, FALSE) AS has_human_list_mode,
  COALESCE(has_both_list_mode, FALSE) AS has_both_list_mode,
  COALESCE(has_unassessed_list_mode, FALSE) AS has_unassessed_list_mode,
  llm_patch_watermark,
  human_patch_watermark,
  both_patch_watermark,
  unassessed_patch_watermark,
  COALESCE(duplicate_flag, FALSE) AS duplicate_flag,
  COALESCE(conflict_flag, FALSE) AS conflict_flag,
  llm_status,
  human_status,
  COALESCE(llm_has_judgment, FALSE) AS llm_has_judgment
FROM mart.review_article_serving_list_mode_state_v4;

DROP TABLE mart.review_article_serving_list_mode_state_v4;

ALTER TABLE mart.review_article_serving_list_mode_state_v4_repair RENAME TO review_article_serving_list_mode_state_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_list_mode_state_v4_pk
ON mart.review_article_serving_list_mode_state_v4(project_id, review_config_hash, snapshot_id, article_id);
