DROP INDEX IF EXISTS app.idx_app_project_mart_dirty_refresh_article_quarantine_barrier;
DROP INDEX IF EXISTS app.idx_app_project_mart_dirty_refresh_article_quarantine_updated_at;

CREATE TEMP TABLE project_mart_dirty_refresh_article_quarantine_rebuild AS
SELECT
  project_id,
  article_id,
  dirty_token,
  error,
  detected_by,
  resolved_at,
  created_at,
  updated_at
FROM app.project_mart_dirty_refresh_article_quarantine;

DROP TABLE app.project_mart_dirty_refresh_article_quarantine;

CREATE TABLE app.project_mart_dirty_refresh_article_quarantine (
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  dirty_token BIGINT NOT NULL,
  error TEXT NOT NULL,
  detected_by VARCHAR,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (project_id, article_id, dirty_token)
);

INSERT INTO app.project_mart_dirty_refresh_article_quarantine (
  project_id,
  article_id,
  dirty_token,
  error,
  detected_by,
  resolved_at,
  created_at,
  updated_at
)
SELECT
  project_id,
  article_id,
  dirty_token,
  error,
  detected_by,
  resolved_at,
  created_at,
  updated_at
FROM project_mart_dirty_refresh_article_quarantine_rebuild;

DROP TABLE project_mart_dirty_refresh_article_quarantine_rebuild;

CREATE INDEX IF NOT EXISTS idx_app_project_mart_dirty_refresh_article_quarantine_barrier
ON app.project_mart_dirty_refresh_article_quarantine(project_id, resolved_at, dirty_token);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_dirty_refresh_article_quarantine_updated_at
ON app.project_mart_dirty_refresh_article_quarantine(updated_at, project_id, article_id);
