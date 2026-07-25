DROP INDEX IF EXISTS mart.idx_review_article_serving_v4_publication_year;
DROP INDEX IF EXISTS idx_review_article_serving_v4_publication_year;
DROP INDEX IF EXISTS mart.idx_review_article_serving_v4_order;
DROP INDEX IF EXISTS idx_review_article_serving_v4_order;
DROP INDEX IF EXISTS mart.idx_review_article_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_article_serving_v4_repaired_pk;
DROP TABLE IF EXISTS mart.review_article_serving_v4_publication_year_repair;

CREATE TABLE mart.review_article_serving_v4_publication_year_repair (
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
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

INSERT INTO mart.review_article_serving_v4_publication_year_repair BY NAME
SELECT COLUMNS(column_name -> column_name IN ('project_id', 'review_config_hash', 'snapshot_id', 'base_generation', 'patch_watermark', 'list_mode_key', 'article_id', 'article_created_at', 'sort_key', 'activity_sort_at'))
FROM mart.review_article_serving_v4;

DROP TABLE mart.review_article_serving_v4;

ALTER TABLE mart.review_article_serving_v4_publication_year_repair RENAME TO review_article_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_v4_repaired_pk
ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_v4_order
ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, sort_key, article_id);

DROP TABLE IF EXISTS mart.review_article_serving_v4_publication_year_repair;
