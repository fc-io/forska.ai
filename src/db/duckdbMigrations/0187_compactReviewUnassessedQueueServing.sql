DROP TABLE IF EXISTS mart.review_unassessed_queue_serving_v4_article_level;

CREATE TABLE mart.review_unassessed_queue_serving_v4_article_level (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  queue_kind VARCHAR NOT NULL,
  priority_bucket INTEGER NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_ids VARCHAR[] NOT NULL,
  queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id)
);

INSERT INTO mart.review_unassessed_queue_serving_v4_article_level (
  project_id,
  review_config_hash,
  snapshot_id,
  queue_kind,
  priority_bucket,
  activity_sort_at,
  article_id,
  prompt_ids,
  queue_updated_at
)
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  queue_kind,
  priority_bucket,
  activity_sort_at,
  article_id,
  COALESCE(
    LIST(DISTINCT prompt_id ORDER BY prompt_id) FILTER (WHERE prompt_id IS NOT NULL),
    []::VARCHAR[]
  ) AS prompt_ids,
  MAX(queue_updated_at) AS queue_updated_at
FROM mart.review_unassessed_queue_serving_v4
GROUP BY
  project_id,
  review_config_hash,
  snapshot_id,
  queue_kind,
  priority_bucket,
  activity_sort_at,
  article_id;

DROP TABLE mart.review_unassessed_queue_serving_v4;

ALTER TABLE mart.review_unassessed_queue_serving_v4_article_level
RENAME TO review_unassessed_queue_serving_v4;

CREATE INDEX IF NOT EXISTS idx_review_unassessed_queue_serving_v4_order
ON mart.review_unassessed_queue_serving_v4(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id);
