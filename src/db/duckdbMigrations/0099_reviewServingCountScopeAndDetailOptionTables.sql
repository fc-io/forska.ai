DROP TABLE IF EXISTS mart.review_article_count_serving_v4;

CREATE TABLE IF NOT EXISTS mart.review_article_count_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  summary_identity VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL DEFAULT 'global',
  count_kind VARCHAR NOT NULL,
  summary_definition_version VARCHAR NOT NULL,
  filter_key VARCHAR NOT NULL,
  count_value BIGINT,
  availability VARCHAR NOT NULL DEFAULT 'ready',
  stale_reason VARCHAR,
  count_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, count_kind, summary_definition_version, filter_key)
);

CREATE INDEX IF NOT EXISTS idx_review_article_count_serving_v4_lookup
ON mart.review_article_count_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, count_kind, filter_key);

DROP TABLE IF EXISTS mart.review_article_judgment_detail_serving_v4;

CREATE TABLE IF NOT EXISTS mart.review_article_judgment_detail_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  payload_kind VARCHAR NOT NULL DEFAULT 'llm',
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  prompt_order INTEGER,
  judgment_id VARCHAR,
  model_id VARCHAR,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  judgment_payload_json JSON,
  placeholder_kind VARCHAR,
  detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)
);

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);

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
