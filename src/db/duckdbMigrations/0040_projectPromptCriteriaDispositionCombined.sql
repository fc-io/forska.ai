CREATE TYPE IF NOT EXISTS project_prompt_criteria_disposition_v2 AS ENUM ('include', 'exclude', 'combined');

DROP INDEX IF EXISTS app.idx_app_project_prompt_project_id;

ALTER TABLE app.project_prompt
ADD COLUMN IF NOT EXISTS criteria_disposition_v2 project_prompt_criteria_disposition_v2;

UPDATE app.project_prompt
SET criteria_disposition_v2 = CAST(criteria_disposition AS VARCHAR)::project_prompt_criteria_disposition_v2;

ALTER TABLE app.project_prompt
DROP COLUMN criteria_disposition;

ALTER TABLE app.project_prompt
RENAME COLUMN criteria_disposition_v2 TO criteria_disposition;

CREATE INDEX IF NOT EXISTS idx_app_project_prompt_project_id
ON app.project_prompt(project_id, prompt_id);
