ALTER TABLE app.comparison_project_serving_generation ADD COLUMN IF NOT EXISTS serving_invalidated_at TIMESTAMPTZ;
