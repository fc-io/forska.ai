DROP TABLE IF EXISTS mart.review_article_serving_payload_v4_display_repair;

CREATE TABLE mart.review_article_serving_payload_v4_display_repair (
  project_id VARCHAR NOT NULL,
  display_identity VARCHAR NOT NULL,
  payload_identity VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_title VARCHAR,
  article_external_id VARCHAR,
  article_updated_at TIMESTAMPTZ,
  arxiv_id VARCHAR,
  biorxiv_id VARCHAR,
  medrxiv_id VARCHAR,
  doi VARCHAR,
  pmid VARCHAR,
  journal_title VARCHAR,
  url VARCHAR,
  full_text_pdf VARCHAR,
  full_text_fetched_at TIMESTAMPTZ,
  full_text_conversion_status VARCHAR,
  source_metadata JSON,
  abstract_text VARCHAR,
  full_text_preview VARCHAR,
  payload_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_article_serving_payload_v4_display_repair
SELECT
  project_id,
  display_identity,
  payload_identity,
  snapshot_id,
  article_id,
  article_created_at,
  NULL AS article_title,
  NULL AS article_external_id,
  NULL AS article_updated_at,
  NULL AS arxiv_id,
  NULL AS biorxiv_id,
  NULL AS medrxiv_id,
  NULL AS doi,
  NULL AS pmid,
  NULL AS journal_title,
  NULL AS url,
  NULL AS full_text_pdf,
  NULL AS full_text_fetched_at,
  NULL AS full_text_conversion_status,
  source_metadata,
  abstract_text,
  full_text_preview,
  payload_updated_at
FROM mart.review_article_serving_payload_v4;

DROP TABLE mart.review_article_serving_payload_v4;

ALTER TABLE mart.review_article_serving_payload_v4_display_repair RENAME TO review_article_serving_payload_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk
ON mart.review_article_serving_payload_v4(project_id, display_identity, payload_identity, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_lookup
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_preview_order
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_created_at, article_id);
