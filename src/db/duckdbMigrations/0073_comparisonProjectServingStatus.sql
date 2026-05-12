ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_status VARCHAR DEFAULT 'missing';

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_generation BIGINT;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_started_at TIMESTAMPTZ;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_completed_at TIMESTAMPTZ;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_failed_at TIMESTAMPTZ;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_error VARCHAR;
