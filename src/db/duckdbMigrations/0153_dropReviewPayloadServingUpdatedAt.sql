DROP TABLE IF EXISTS mart.review_article_serving_payload_v4_updated_at_repair;

CREATE TABLE mart.review_article_serving_payload_v4_updated_at_repair (
  project_id VARCHAR NOT NULL,
  display_identity VARCHAR NOT NULL,
  payload_identity VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  source_metadata JSON,
  abstract_text VARCHAR,
  full_text_preview VARCHAR
);

INSERT INTO mart.review_article_serving_payload_v4_updated_at_repair
SELECT
  project_id,
  display_identity,
  payload_identity,
  snapshot_id,
  article_id,
  article_created_at,
  source_metadata,
  abstract_text,
  full_text_preview
FROM mart.review_article_serving_payload_v4;

DROP TABLE mart.review_article_serving_payload_v4;

ALTER TABLE mart.review_article_serving_payload_v4_updated_at_repair RENAME TO review_article_serving_payload_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk
ON mart.review_article_serving_payload_v4(project_id, display_identity, payload_identity, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_lookup
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_preview_order
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_created_at, article_id);

DROP TABLE IF EXISTS mart.review_article_serving_payload_v4_updated_at_repair;
