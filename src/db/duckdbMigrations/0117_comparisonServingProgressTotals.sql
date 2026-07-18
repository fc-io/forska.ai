ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_total_article_count BIGINT;

ALTER TABLE app.comparison_project_serving_generation
ADD COLUMN IF NOT EXISTS serving_total_cell_count BIGINT;
