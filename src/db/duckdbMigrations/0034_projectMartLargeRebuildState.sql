CREATE TABLE IF NOT EXISTS app.project_mart_large_rebuild_state (
  project_id VARCHAR PRIMARY KEY REFERENCES app.project(id),
  refresh_token BIGINT NOT NULL DEFAULT 0,
  rebuild_phase VARCHAR NOT NULL DEFAULT 'project_scope_article',
  cursor_article_created_at TIMESTAMPTZ,
  cursor_article_id VARCHAR,
  target_generation BIGINT,
  refresh_status VARCHAR NOT NULL DEFAULT 'idle',
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  last_error VARCHAR,
  worker_id VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_large_rebuild_state_claim
ON app.project_mart_large_rebuild_state(refresh_status, refresh_token, rebuild_phase);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_large_rebuild_state_stale_work
ON app.project_mart_large_rebuild_state(refresh_status, lease_expires_at);
