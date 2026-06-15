DROP TABLE IF EXISTS mart.review_filter_facet_serving_v4;

CREATE TABLE IF NOT EXISTS mart.review_filter_facet_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  summary_identity VARCHAR NOT NULL,
  facet_kind VARCHAR NOT NULL,
  facet_key VARCHAR NOT NULL,
  facet_value VARCHAR NOT NULL,
  prompt_id VARCHAR,
  answer_id INTEGER,
  answer_value VARCHAR,
  summary_definition_version VARCHAR NOT NULL,
  count_value BIGINT,
  availability VARCHAR NOT NULL DEFAULT 'ready',
  facet_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value, summary_definition_version)
);

CREATE INDEX IF NOT EXISTS idx_review_filter_facet_serving_v4_lookup
ON mart.review_filter_facet_serving_v4(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value);
