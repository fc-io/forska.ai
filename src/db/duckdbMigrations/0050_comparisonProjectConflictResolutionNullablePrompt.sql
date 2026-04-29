DROP INDEX IF EXISTS app.idx_app_comparison_project_conflict_resolution_lookup;

CREATE TEMP TABLE comparison_project_conflict_resolution_nullable_prompt_backup AS
SELECT
  id,
  comparison_project_id,
  article_id,
  prompt_id,
  answer_value,
  created_at,
  updated_at
FROM app.comparison_project_conflict_resolution;

DROP TABLE app.comparison_project_conflict_resolution;

CREATE TABLE app.comparison_project_conflict_resolution (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL REFERENCES app.comparison_project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR REFERENCES app.prompt(id),
  answer_value VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, article_id)
);

INSERT INTO app.comparison_project_conflict_resolution (
  id,
  comparison_project_id,
  article_id,
  prompt_id,
  answer_value,
  created_at,
  updated_at
)
SELECT
  id,
  comparison_project_id,
  article_id,
  prompt_id,
  answer_value,
  created_at,
  updated_at
FROM comparison_project_conflict_resolution_nullable_prompt_backup;

CREATE INDEX IF NOT EXISTS idx_app_comparison_project_conflict_resolution_lookup
ON app.comparison_project_conflict_resolution(comparison_project_id, article_id);
