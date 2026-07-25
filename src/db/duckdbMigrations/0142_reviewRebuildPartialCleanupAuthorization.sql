CREATE TABLE IF NOT EXISTS app.review_rebuild_partial_cleanup_authorization (
  authorization_id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  request_id VARCHAR NOT NULL,
  chunk_id VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  partial_table VARCHAR NOT NULL,
  cleanup_mode VARCHAR NOT NULL,
  reason VARCHAR NOT NULL,
  evidence_json JSON NOT NULL DEFAULT '{}',
  expected_row_count BIGINT NOT NULL,
  observed_row_count BIGINT NOT NULL,
  operator_ack VARCHAR NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  expires_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ,
  applied_row_count BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(authorization_id)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(review_config_hash)) > 0),
  CHECK (length(trim(request_id)) > 0),
  CHECK (length(trim(chunk_id)) > 0),
  CHECK (length(trim(snapshot_id)) > 0),
  CHECK (
    partial_table IN (
      'mart.review_article_summary_contribution_rebuild_partial_v4',
      'mart.review_article_summary_rebuild_partial_v4'
    )
  ),
  CHECK (cleanup_mode IN ('stale_orphan_summary_partial')),
  CHECK (length(trim(reason)) > 0),
  CHECK (expected_row_count >= 0),
  CHECK (observed_row_count >= 0),
  CHECK (applied_row_count IS NULL OR applied_row_count >= 0),
  CHECK (length(trim(operator_ack)) > 0),
  CHECK (expires_at > authorized_at)
);

CREATE INDEX IF NOT EXISTS idx_review_rebuild_partial_cleanup_authorization_lookup
ON app.review_rebuild_partial_cleanup_authorization(
  project_id,
  review_config_hash,
  request_id,
  chunk_id,
  snapshot_id,
  partial_table,
  expires_at
);
