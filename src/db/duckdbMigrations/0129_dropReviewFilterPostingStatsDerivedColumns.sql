DROP TABLE IF EXISTS mart.review_filter_posting_stats_v4_repair;

CREATE TABLE mart.review_filter_posting_stats_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  filter_kind VARCHAR NOT NULL,
  filter_value VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  cardinality BIGINT NOT NULL,
  stats_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (cardinality >= 0)
);

INSERT INTO mart.review_filter_posting_stats_v4_repair
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  filter_kind,
  filter_value,
  list_mode_key,
  cardinality,
  stats_updated_at
FROM mart.review_filter_posting_stats_v4;

DROP TABLE mart.review_filter_posting_stats_v4;

ALTER TABLE mart.review_filter_posting_stats_v4_repair RENAME TO review_filter_posting_stats_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filter_posting_stats_v4_repaired_pk
ON mart.review_filter_posting_stats_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key);
