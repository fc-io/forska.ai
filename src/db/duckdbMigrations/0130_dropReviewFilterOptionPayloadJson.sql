DROP TABLE IF EXISTS mart.review_filter_option_serving_v4_repair;

CREATE TABLE mart.review_filter_option_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  search_identity VARCHAR NOT NULL DEFAULT 'none',
  filter_option_identity VARCHAR NOT NULL,
  option_value_key VARCHAR NOT NULL,
  filter_kind VARCHAR NOT NULL,
  facet_key VARCHAR NOT NULL,
  facet_value VARCHAR,
  prompt_id VARCHAR,
  answer_id INTEGER,
  numeric_min DOUBLE,
  numeric_max DOUBLE,
  count_value BIGINT,
  option_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_filter_option_serving_v4_repair
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  search_identity,
  filter_option_identity,
  option_value_key,
  filter_kind,
  facet_key,
  facet_value,
  prompt_id,
  answer_id,
  numeric_min,
  numeric_max,
  count_value,
  option_updated_at
FROM mart.review_filter_option_serving_v4;

DROP TABLE mart.review_filter_option_serving_v4;

ALTER TABLE mart.review_filter_option_serving_v4_repair RENAME TO review_filter_option_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_repaired_pk
ON mart.review_filter_option_serving_v4(project_id, review_config_hash, snapshot_id, search_identity, filter_option_identity, filter_kind, facet_key, option_value_key);

CREATE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_lookup
ON mart.review_filter_option_serving_v4(project_id, review_config_hash, snapshot_id, search_identity, filter_kind, facet_key, option_value_key);
