UPDATE app.comparison_project_serving_generation
SET
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
