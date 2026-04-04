CREATE TABLE IF NOT EXISTS app.project_mart_refresh_article_quarantine (
  article_id VARCHAR PRIMARY KEY REFERENCES app.article(id),
  error TEXT NOT NULL,
  detected_by VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_article_quarantine_updated_at
ON app.project_mart_refresh_article_quarantine(updated_at, article_id);