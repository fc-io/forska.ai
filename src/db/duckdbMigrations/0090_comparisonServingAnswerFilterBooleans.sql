DROP INDEX IF EXISTS mart.idx_mart_comparison_article_serving_order;
DROP INDEX IF EXISTS idx_mart_comparison_article_serving_order;

ALTER TABLE mart.comparison_article_serving
ADD COLUMN IF NOT EXISTS has_llm_answered_yes BOOLEAN DEFAULT FALSE;

ALTER TABLE mart.comparison_article_serving
ADD COLUMN IF NOT EXISTS has_llm_answered_no BOOLEAN DEFAULT FALSE;

ALTER TABLE mart.comparison_article_serving
ADD COLUMN IF NOT EXISTS has_llm_answered_maybe BOOLEAN DEFAULT FALSE;

ALTER TABLE mart.comparison_article_serving
ADD COLUMN IF NOT EXISTS has_human_answered_yes BOOLEAN DEFAULT FALSE;

ALTER TABLE mart.comparison_article_serving
ADD COLUMN IF NOT EXISTS has_human_answered_no BOOLEAN DEFAULT FALSE;

ALTER TABLE mart.comparison_article_serving
ADD COLUMN IF NOT EXISTS has_human_answered_maybe BOOLEAN DEFAULT FALSE;

UPDATE app.comparison_project_serving_generation
SET
  active_generation = 0,
  serving_status = 'stale',
  serving_generation = NULL,
  serving_started_at = NULL,
  serving_completed_at = NULL,
  serving_failed_at = NULL,
  serving_error = NULL,
  serving_phase = NULL,
  serving_phase_started_at = NULL,
  serving_last_progressed_at = NULL,
  serving_staged_article_count = 0,
  serving_staged_cell_count = 0,
  serving_staged_filter_member_count = 0,
  serving_staged_filter_stats_count = 0,
  generation_updated_at = current_timestamp;

CREATE INDEX IF NOT EXISTS idx_mart_comparison_article_serving_order
ON mart.comparison_article_serving(comparison_project_id, generation, row_sort_created_at, row_sort_title, row_sort_article_id);
