CREATE TABLE IF NOT EXISTS mart.review_article_filter_state_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
  llm_status VARCHAR,
  human_status VARCHAR
);

INSERT INTO mart.review_article_filter_state_serving_v4 (
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  article_id,
  duplicate_flag,
  conflict_flag,
  llm_status,
  human_status
)
SELECT
  posting.project_id,
  posting.review_config_hash,
  posting.snapshot_id,
  posting.list_mode_key,
  posting.article_id,
  COALESCE(BOOL_OR(posting.filter_kind = 'duplicateFlag' AND posting.filter_value = 'true'), FALSE) AS duplicate_flag,
  COALESCE(BOOL_OR(posting.filter_kind = 'conflictFlag' AND posting.filter_value = 'true'), FALSE) AS conflict_flag,
  MAX(CASE WHEN posting.filter_kind = 'llmStatus' THEN posting.filter_value END) AS llm_status,
  MAX(CASE WHEN posting.filter_kind = 'humanStatus' THEN posting.filter_value END) AS human_status
FROM mart.review_article_filter_posting_serving_v4 posting
WHERE posting.filter_kind IN ('duplicateFlag', 'conflictFlag', 'llmStatus', 'humanStatus')
GROUP BY
  posting.project_id,
  posting.review_config_hash,
  posting.snapshot_id,
  posting.list_mode_key,
  posting.article_id;

DELETE FROM mart.review_article_filter_posting_serving_v4
WHERE filter_kind IN ('duplicateFlag', 'conflictFlag', 'llmStatus', 'humanStatus');

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_filter_state_serving_v4_pk
ON mart.review_article_filter_state_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_filter_state_serving_v4_lookup
ON mart.review_article_filter_state_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, duplicate_flag, conflict_flag, llm_status, human_status, article_id);
