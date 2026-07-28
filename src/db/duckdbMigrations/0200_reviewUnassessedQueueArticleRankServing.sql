CREATE TABLE IF NOT EXISTS mart.review_unassessed_queue_article_rank_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  queue_kind VARCHAR NOT NULL,
  priority_bucket INTEGER NOT NULL,
  article_id VARCHAR NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE OR REPLACE TEMP TABLE review_unassessed_queue_article_rank_backfill_v4 AS
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
WHERE article_rank = 1;

UPDATE mart.review_unassessed_queue_article_rank_serving_v4 existing
SET
  priority_bucket = backfill.priority_bucket,
  activity_sort_at = backfill.activity_sort_at,
  queue_updated_at = backfill.queue_updated_at
FROM review_unassessed_queue_article_rank_backfill_v4 backfill
WHERE existing.project_id IS NOT DISTINCT FROM backfill.project_id
  AND existing.review_config_hash IS NOT DISTINCT FROM backfill.review_config_hash
  AND existing.snapshot_id IS NOT DISTINCT FROM backfill.snapshot_id
  AND existing.queue_kind IS NOT DISTINCT FROM backfill.queue_kind
  AND existing.article_id IS NOT DISTINCT FROM backfill.article_id;

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
FROM review_unassessed_queue_article_rank_backfill_v4 backfill
WHERE NOT EXISTS (
  SELECT 1
  FROM mart.review_unassessed_queue_article_rank_serving_v4 existing
  WHERE existing.project_id IS NOT DISTINCT FROM backfill.project_id
    AND existing.review_config_hash IS NOT DISTINCT FROM backfill.review_config_hash
    AND existing.snapshot_id IS NOT DISTINCT FROM backfill.snapshot_id
    AND existing.queue_kind IS NOT DISTINCT FROM backfill.queue_kind
    AND existing.article_id IS NOT DISTINCT FROM backfill.article_id
);

DROP TABLE IF EXISTS review_unassessed_queue_article_rank_backfill_v4;
