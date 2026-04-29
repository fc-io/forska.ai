ALTER TABLE app.comparison_project_conflict_resolution
ADD COLUMN IF NOT EXISTS prompt_id VARCHAR;

ALTER TABLE app.comparison_project_conflict_resolution
ADD COLUMN IF NOT EXISTS answer_value VARCHAR;
