ALTER TABLE mart.comparison_article_serving ADD COLUMN IF NOT EXISTS doi VARCHAR;
ALTER TABLE mart.comparison_article_serving ADD COLUMN IF NOT EXISTS pubmed_id VARCHAR;
ALTER TABLE mart.comparison_article_serving ADD COLUMN IF NOT EXISTS arxiv_id VARCHAR;
ALTER TABLE mart.comparison_article_serving ADD COLUMN IF NOT EXISTS biorxiv_id VARCHAR;
ALTER TABLE mart.comparison_article_serving ADD COLUMN IF NOT EXISTS medrxiv_id VARCHAR;

CREATE TABLE IF NOT EXISTS mart.comparison_article_identifier_serving (
  comparison_project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  article_id VARCHAR NOT NULL,
  source_identifier_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  normalized_value VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(comparison_project_id, generation, article_id, source_identifier_id)
);

CREATE INDEX IF NOT EXISTS idx_mart_comparison_article_identifier_serving_lookup
ON mart.comparison_article_identifier_serving(comparison_project_id, generation, article_id, is_primary, kind, normalized_value, source_identifier_id);

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
