ALTER TABLE app.judgment_job ADD COLUMN IF NOT EXISTS full_text_strategy_id VARCHAR;
ALTER TABLE app.judgment_execution_snapshot ADD COLUMN IF NOT EXISTS full_text_strategy_id VARCHAR DEFAULT 'fts-none';
UPDATE app.judgment_job
SET full_text_strategy_id = (
  SELECT project.full_text_strategy_id
  FROM app.project project
  WHERE project.id = app.judgment_job.project_id
)
WHERE full_text_strategy_id IS NULL;
UPDATE app.judgment_execution_snapshot
SET full_text_strategy_id = 'fts-legacy-v0'
WHERE use_fulltext OR use_fulltext_no_images;
