DROP TABLE IF EXISTS mart.review_unassessed_queue_serving_v4_noindex_repair_0209;

CREATE TABLE mart.review_unassessed_queue_serving_v4_noindex_repair_0209 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  queue_kind VARCHAR NOT NULL,
  priority_bucket INTEGER NOT NULL,
  activity_sort_at TIMESTAMPTZ NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_ids VARCHAR[] NOT NULL,
  queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_unassessed_queue_serving_v4_noindex_repair_0209 BY NAME
SELECT * FROM mart.review_unassessed_queue_serving_v4;

DROP TABLE mart.review_unassessed_queue_serving_v4;

ALTER TABLE mart.review_unassessed_queue_serving_v4_noindex_repair_0209
RENAME TO review_unassessed_queue_serving_v4;
