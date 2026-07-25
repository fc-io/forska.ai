DROP TABLE IF EXISTS mart.review_article_serving_payload_v4_full_text_preview_repair;

CREATE TABLE mart.review_article_serving_payload_v4_full_text_preview_repair (
  project_id VARCHAR NOT NULL,
  display_identity VARCHAR NOT NULL,
  payload_identity VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL
);

INSERT INTO mart.review_article_serving_payload_v4_full_text_preview_repair BY NAME
SELECT COLUMNS(column_name -> column_name IN ('project_id', 'display_identity', 'payload_identity', 'snapshot_id', 'article_id'))
FROM mart.review_article_serving_payload_v4;

DROP TABLE mart.review_article_serving_payload_v4;

ALTER TABLE mart.review_article_serving_payload_v4_full_text_preview_repair RENAME TO review_article_serving_payload_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk
ON mart.review_article_serving_payload_v4(project_id, display_identity, payload_identity, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_lookup
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_id);

DROP TABLE IF EXISTS mart.review_article_serving_payload_v4_full_text_preview_repair;
