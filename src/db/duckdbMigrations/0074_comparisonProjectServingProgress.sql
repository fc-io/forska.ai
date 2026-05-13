ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_phase VARCHAR;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_phase_started_at TIMESTAMPTZ;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_last_progressed_at TIMESTAMPTZ;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_staged_article_count BIGINT DEFAULT 0;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_staged_cell_count BIGINT DEFAULT 0;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_staged_filter_member_count BIGINT DEFAULT 0;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_staged_filter_stats_count BIGINT DEFAULT 0;
