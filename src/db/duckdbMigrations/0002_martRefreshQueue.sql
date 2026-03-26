CREATE TABLE IF NOT EXISTS app.mart_refresh_queue (
  id VARCHAR PRIMARY KEY,
  refresh_scope VARCHAR NOT NULL,
  project_id VARCHAR,
  article_id VARCHAR,
  project_key VARCHAR NOT NULL DEFAULT '',
  article_key VARCHAR NOT NULL DEFAULT '',
  refresh_generation BIGINT NOT NULL DEFAULT 0,
  reason VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(refresh_scope, project_key, article_key)
);

CREATE INDEX IF NOT EXISTS idx_app_mart_refresh_queue_created_at ON app.mart_refresh_queue(created_at);
