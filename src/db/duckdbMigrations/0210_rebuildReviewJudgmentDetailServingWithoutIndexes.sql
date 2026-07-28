DROP TABLE IF EXISTS mart.review_article_judgment_detail_serving_v4_noindex_repair_0210;

CREATE TABLE mart.review_article_judgment_detail_serving_v4_noindex_repair_0210 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
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

INSERT INTO mart.review_article_judgment_detail_serving_v4_noindex_repair_0210 BY NAME
SELECT * FROM mart.review_article_judgment_detail_serving_v4;

DROP INDEX IF EXISTS mart.idx_review_article_judgment_detail_serving_v4_article;
DROP INDEX IF EXISTS idx_review_article_judgment_detail_serving_v4_article;
DROP INDEX IF EXISTS mart.idx_review_article_judgment_detail_serving_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_article_judgment_detail_serving_v4_repaired_pk;

DROP TABLE mart.review_article_judgment_detail_serving_v4;

ALTER TABLE mart.review_article_judgment_detail_serving_v4_noindex_repair_0210
RENAME TO review_article_judgment_detail_serving_v4;
