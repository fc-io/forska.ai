CREATE TABLE IF NOT EXISTS app.project_mart_refresh_state (
  project_id VARCHAR PRIMARY KEY REFERENCES app.project(id),
  dirty_token BIGINT NOT NULL DEFAULT 0,
  active_refresh_token BIGINT NOT NULL DEFAULT 0,
  last_completed_refresh_token BIGINT NOT NULL DEFAULT 0,
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  last_request_reason VARCHAR,
  requested_by VARCHAR,
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

CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_state_claim
ON app.project_mart_refresh_state(refresh_status, dirty_token, last_completed_refresh_token);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_state_stale_work
ON app.project_mart_refresh_state(refresh_status, lease_expires_at);
