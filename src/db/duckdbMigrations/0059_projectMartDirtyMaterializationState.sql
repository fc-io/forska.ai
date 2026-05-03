DROP INDEX IF EXISTS app.idx_app_project_mart_refresh_state_claim;

DROP INDEX IF EXISTS app.idx_app_project_mart_refresh_state_stale_work;

ALTER TABLE app.project_mart_refresh_state RENAME COLUMN active_refresh_token TO active_dirty_token;

ALTER TABLE app.project_mart_refresh_state RENAME COLUMN last_completed_refresh_token TO last_completed_dirty_token;

CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_state_claim
ON app.project_mart_refresh_state(refresh_status, dirty_token, last_completed_dirty_token);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_state_stale_work
ON app.project_mart_refresh_state(refresh_status, lease_expires_at);

CREATE TABLE IF NOT EXISTS app.project_mart_dirty_materialization_state (
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  source_kind VARCHAR NOT NULL,
  target_dirty_token BIGINT NOT NULL,
  cursor_article_created_at TIMESTAMPTZ,
  cursor_article_id VARCHAR,
  inserted_row_count BIGINT NOT NULL DEFAULT 0,
  source_scope_generation BIGINT,
  source_scope_high_water_article_created_at TIMESTAMPTZ,
  source_scope_high_water_article_id VARCHAR,
  source_scope_fingerprint VARCHAR,
  materialization_status VARCHAR NOT NULL DEFAULT 'pending',
  materialization_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (project_id, source_kind, target_dirty_token)
);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_dirty_materialization_state_claim
ON app.project_mart_dirty_materialization_state(materialization_status, source_kind, target_dirty_token);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_dirty_materialization_state_stale_work
ON app.project_mart_dirty_materialization_state(materialization_status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_dirty_materialization_state_project_token
ON app.project_mart_dirty_materialization_state(project_id, target_dirty_token, materialization_status);
