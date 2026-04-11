CREATE TYPE human_judgment_mode AS ENUM ('prompt', 'summary');

CREATE TYPE project_prompt_criteria_disposition AS ENUM ('include', 'exclude');

ALTER TABLE app.project
ADD COLUMN IF NOT EXISTS human_judgment_mode human_judgment_mode DEFAULT 'prompt';

ALTER TABLE app.project_prompt
ADD COLUMN IF NOT EXISTS criteria_disposition project_prompt_criteria_disposition;

ALTER TABLE app.project_prompt
ADD COLUMN IF NOT EXISTS criteria_section_key VARCHAR;

ALTER TABLE app.project_prompt
ADD COLUMN IF NOT EXISTS criteria_section_label VARCHAR;

CREATE TABLE IF NOT EXISTS app.judgment_human_summary (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  answer VARCHAR CHECK (answer IN ('yes', 'no', 'maybe') OR answer IS NULL),
  origin VARCHAR NOT NULL CHECK (origin IN ('covidence_import', 'manual_override')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_app_judgment_human_summary_project_id
ON app.judgment_human_summary(project_id, article_id);

CREATE INDEX IF NOT EXISTS idx_app_judgment_human_summary_article_id
ON app.judgment_human_summary(article_id, project_id);
