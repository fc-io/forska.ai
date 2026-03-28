CREATE TEMP TABLE judgment_human_nullable_project_id_backup AS
SELECT * FROM app.judgment_human;

DROP TABLE app.judgment_human;

CREATE TABLE app.judgment_human (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  is_answered BOOLEAN NOT NULL DEFAULT FALSE,
  answer VARCHAR,
  comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id, prompt_id)
);

INSERT INTO app.judgment_human
SELECT * FROM judgment_human_nullable_project_id_backup;

CREATE INDEX IF NOT EXISTS idx_app_judgment_human_lookup ON app.judgment_human(project_id, article_id, prompt_id);
