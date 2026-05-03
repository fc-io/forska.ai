DROP INDEX IF EXISTS app.idx_app_project_mart_refresh_article_quarantine_updated_at;

ALTER TABLE app.project_mart_refresh_article_quarantine RENAME TO project_mart_refresh_article_quarantine_legacy;

CREATE TABLE app.project_mart_refresh_article_quarantine (
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

INSERT INTO app.project_mart_refresh_article_quarantine (
  project_id,
  article_id,
  dirty_token,
  error,
  detected_by,
  created_at,
  updated_at
)
SELECT
  article_state.project_id,
  legacy.article_id,
  GREATEST(article_state.first_dirty_token, 1),
  legacy.error,
  legacy.detected_by,
  legacy.created_at,
  legacy.updated_at
FROM app.project_mart_refresh_article_quarantine_legacy legacy
INNER JOIN app.project_mart_refresh_article_state article_state
  ON article_state.article_id = legacy.article_id;

DROP TABLE app.project_mart_refresh_article_quarantine_legacy;

CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_article_quarantine_barrier
ON app.project_mart_refresh_article_quarantine(project_id, resolved_at, dirty_token);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_article_quarantine_updated_at
ON app.project_mart_refresh_article_quarantine(updated_at, project_id, article_id);
