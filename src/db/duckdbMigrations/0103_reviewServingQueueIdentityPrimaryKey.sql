DROP TABLE IF EXISTS mart.review_unassessed_queue_serving_v4;

CREATE TABLE IF NOT EXISTS mart.review_unassessed_queue_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  queue_identity VARCHAR NOT NULL,
  queue_kind VARCHAR NOT NULL,
  priority_bucket INTEGER NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR,
  queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id, prompt_id, queue_identity)
);

CREATE INDEX IF NOT EXISTS idx_review_unassessed_queue_serving_v4_order
ON mart.review_unassessed_queue_serving_v4(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id);
