CREATE TABLE IF NOT EXISTS app.project_mart_refresh_article_state (
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  first_dirty_token BIGINT NOT NULL,
  last_dirty_token BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (project_id, article_id),
  CHECK (first_dirty_token <= last_dirty_token)
);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_article_state_dirty_range
ON app.project_mart_refresh_article_state(project_id, last_dirty_token, first_dirty_token);
