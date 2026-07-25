DROP INDEX IF EXISTS mart.idx_review_article_filter_posting_serving_v4_lookup;
DROP INDEX IF EXISTS idx_review_article_filter_posting_serving_v4_lookup;
DROP INDEX IF EXISTS mart.idx_review_article_filter_posting_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_article_filter_posting_serving_v4_repaired_pk;
DROP TABLE IF EXISTS mart.review_article_filter_posting_serving_v4_repair;

CREATE TABLE mart.review_article_filter_posting_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  filter_kind VARCHAR NOT NULL,
  filter_value VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL
);

INSERT INTO mart.review_article_filter_posting_serving_v4_repair
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  filter_kind,
  filter_value,
  list_mode_key,
  article_id
FROM mart.review_article_filter_posting_serving_v4;

DROP TABLE mart.review_article_filter_posting_serving_v4;

ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_repaired_pk
ON mart.review_article_filter_posting_serving_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_lookup
ON mart.review_article_filter_posting_serving_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, article_id);
