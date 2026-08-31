DROP INDEX IF EXISTS mart.idx_mart_comparison_filter_stats_lookup;
DROP INDEX IF EXISTS idx_mart_comparison_filter_stats_lookup;
DROP TABLE IF EXISTS mart.comparison_filter_stats_repair;

CREATE TABLE mart.comparison_filter_stats_repair (
  comparison_project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  row_filter VARCHAR NOT NULL,
  difference_filter VARCHAR NOT NULL,
  article_category_filter VARCHAR NOT NULL DEFAULT 'all',
  total_count BIGINT NOT NULL,
  stats_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(comparison_project_id, generation, row_filter, difference_filter, article_category_filter)
);

INSERT INTO mart.comparison_filter_stats_repair (
  comparison_project_id,
  generation,
  row_filter,
  difference_filter,
  article_category_filter,
  total_count,
  stats_updated_at
)
SELECT
  comparison_project_id,
  generation,
  row_filter,
  difference_filter,
  'all' AS article_category_filter,
  total_count,
  stats_updated_at
FROM mart.comparison_filter_stats;

DROP TABLE mart.comparison_filter_stats;

ALTER TABLE mart.comparison_filter_stats_repair RENAME TO comparison_filter_stats;

CREATE INDEX IF NOT EXISTS idx_mart_comparison_filter_stats_lookup
ON mart.comparison_filter_stats(comparison_project_id, generation, row_filter, difference_filter, article_category_filter);

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

DROP TABLE IF EXISTS mart.comparison_filter_stats_repair;
