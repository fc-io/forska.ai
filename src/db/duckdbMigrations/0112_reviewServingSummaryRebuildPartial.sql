CREATE TABLE IF NOT EXISTS mart.review_article_summary_rebuild_partial_v4 (
  request_id VARCHAR NOT NULL,
  chunk_id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  serving_key VARCHAR NOT NULL,
  summary_kind VARCHAR NOT NULL,
  summary_identity VARCHAR NOT NULL,
  list_mode_key VARCHAR,
  count_kind VARCHAR,
  summary_definition_version VARCHAR NOT NULL,
  filter_key VARCHAR,
  facet_kind VARCHAR,
  facet_key VARCHAR,
  facet_value VARCHAR,
  prompt_id VARCHAR,
  answer_id INTEGER,
  answer_value VARCHAR,
  availability VARCHAR NOT NULL DEFAULT 'ready',
  stale_reason VARCHAR,
  count_value BIGINT,
  partial_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(request_id, chunk_id, project_id, review_config_hash, snapshot_id, serving_key)
);

CREATE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_reduce
ON mart.review_article_summary_rebuild_partial_v4(request_id, project_id, review_config_hash, snapshot_id, summary_kind);
