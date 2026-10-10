ALTER TABLE app.comparison_project_conflict_resolution ADD COLUMN IF NOT EXISTS comment VARCHAR;
ALTER TABLE app.comparison_project_conflict_resolution ADD COLUMN IF NOT EXISTS comment_updated_at TIMESTAMPTZ;
