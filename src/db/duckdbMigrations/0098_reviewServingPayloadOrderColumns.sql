ALTER TABLE mart.review_article_serving_payload_v4
ADD COLUMN IF NOT EXISTS article_created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_preview_order
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_created_at, article_id);
