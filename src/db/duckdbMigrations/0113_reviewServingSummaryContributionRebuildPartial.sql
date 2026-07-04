CREATE TABLE IF NOT EXISTS mart.review_article_summary_contribution_rebuild_partial_v4 (
  request_id VARCHAR NOT NULL,
  chunk_id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  component_kind VARCHAR NOT NULL,
  summary_definition_version VARCHAR NOT NULL,
  contribution_key VARCHAR NOT NULL,
  contribution_value BIGINT NOT NULL,
  contribution_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(request_id, chunk_id, project_id, review_config_hash, snapshot_id, article_id, component_kind, summary_definition_version, contribution_key)
);

CREATE INDEX IF NOT EXISTS idx_review_article_summary_contribution_rebuild_partial_v4_publish
ON mart.review_article_summary_contribution_rebuild_partial_v4(request_id, project_id, review_config_hash, snapshot_id);
