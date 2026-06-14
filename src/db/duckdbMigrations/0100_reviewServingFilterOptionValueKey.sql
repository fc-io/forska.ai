DROP TABLE IF EXISTS mart.review_filter_option_serving_v4;

CREATE TABLE IF NOT EXISTS mart.review_filter_option_serving_v4 (
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
  option_payload_json JSON,
  count_value BIGINT,
  option_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, search_identity, filter_option_identity, filter_kind, facet_key, option_value_key)
);

CREATE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_lookup
ON mart.review_filter_option_serving_v4(project_id, review_config_hash, snapshot_id, search_identity, filter_kind, facet_key, option_value_key);
