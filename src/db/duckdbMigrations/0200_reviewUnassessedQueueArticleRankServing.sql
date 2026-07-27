CREATE TABLE IF NOT EXISTS mart.review_unassessed_queue_article_rank_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  queue_kind VARCHAR NOT NULL,
  priority_bucket INTEGER NOT NULL,
  article_id VARCHAR NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, queue_kind, article_id)
);

INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4 (
  project_id,
  review_config_hash,
  snapshot_id,
  queue_kind,
  priority_bucket,
  article_id,
  activity_sort_at,
  queue_updated_at
)
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  queue_kind,
  priority_bucket,
  article_id,
  activity_sort_at,
  queue_updated_at
FROM (
  SELECT
    project_id,
    review_config_hash,
    snapshot_id,
    queue_kind,
    priority_bucket,
    article_id,
    activity_sort_at,
    MAX(queue_updated_at) OVER (
      PARTITION BY project_id, review_config_hash, snapshot_id, queue_kind, article_id
    ) AS queue_updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY project_id, review_config_hash, snapshot_id, queue_kind, article_id
      ORDER BY priority_bucket DESC, activity_sort_at DESC, article_id DESC
    ) AS article_rank
  FROM mart.review_unassessed_queue_serving_v4
) ranked_queue
WHERE article_rank = 1
ON CONFLICT(project_id, review_config_hash, snapshot_id, queue_kind, article_id) DO UPDATE SET
  priority_bucket = excluded.priority_bucket,
  activity_sort_at = excluded.activity_sort_at,
  queue_updated_at = excluded.queue_updated_at;

CREATE INDEX IF NOT EXISTS idx_review_unassessed_queue_article_rank_serving_v4_order
ON mart.review_unassessed_queue_article_rank_serving_v4(
  project_id,
  review_config_hash,
  snapshot_id,
  queue_kind,
  priority_bucket,
  activity_sort_at,
  article_id
);
