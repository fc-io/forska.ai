CREATE TABLE IF NOT EXISTS app.comparison_project_serving_generation (
  comparison_project_id VARCHAR NOT NULL PRIMARY KEY,
  active_generation BIGINT NOT NULL,
  generation_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS mart.comparison_article_serving (
  comparison_project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_title VARCHAR NOT NULL,
  article_summary VARCHAR,
  article_external_id VARCHAR,
  doi VARCHAR,
  pubmed_id VARCHAR,
  arxiv_id VARCHAR,
  biorxiv_id VARCHAR,
  medrxiv_id VARCHAR,
  journal_title VARCHAR,
  url VARCHAR,
  full_text_pdf VARCHAR,
  full_text_fetched_at TIMESTAMPTZ,
  full_text_conversion_status VARCHAR,
  source_metadata JSON,
  row_sort_created_at TIMESTAMPTZ,
  row_sort_title VARCHAR NOT NULL,
  row_sort_article_id VARCHAR NOT NULL,
  answered_prompt_count INTEGER NOT NULL,
  answered_column_count INTEGER NOT NULL,
  answered_llm_column_count INTEGER NOT NULL,
  answered_human_column_count INTEGER NOT NULL,
  required_column_count INTEGER NOT NULL,
  required_llm_column_count INTEGER NOT NULL,
  required_human_column_count INTEGER NOT NULL,
  has_all_llm_columns BOOLEAN NOT NULL,
  has_all_human_columns BOOLEAN NOT NULL,
  has_multiple_answers BOOLEAN NOT NULL,
  is_fully_answered BOOLEAN NOT NULL,
  passes_row_filter_multiple_answers BOOLEAN NOT NULL,
  passes_row_filter_fully_answered BOOLEAN NOT NULL,
  passes_row_filter_all BOOLEAN NOT NULL,
  has_human_vs_llm_difference BOOLEAN NOT NULL,
  has_llm_vs_llm_difference BOOLEAN NOT NULL,
  has_any_disagreement BOOLEAN NOT NULL,
  passes_difference_filter_human_vs_llm BOOLEAN NOT NULL,
  passes_difference_filter_llm_vs_llm BOOLEAN NOT NULL,
  passes_difference_filter_any_disagreement BOOLEAN NOT NULL,
  passes_difference_filter_all BOOLEAN NOT NULL,
  has_conflict BOOLEAN NOT NULL,
  serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(comparison_project_id, generation, article_id)
);

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

CREATE TABLE IF NOT EXISTS mart.comparison_cell_serving (
  comparison_project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  article_id VARCHAR NOT NULL,
  column_id VARCHAR NOT NULL,
  column_order INTEGER NOT NULL,
  kind VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  model_id VARCHAR,
  source_project_id VARCHAR,
  content_key VARCHAR,
  display_answer VARCHAR,
  normalized_answers VARCHAR[] NOT NULL,
  source_created_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  cell_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(comparison_project_id, generation, article_id, column_id)
);

CREATE TABLE IF NOT EXISTS mart.comparison_filter_member (
  comparison_project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  row_filter VARCHAR NOT NULL,
  difference_filter VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  ordinal BIGINT NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_title VARCHAR NOT NULL,
  member_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(comparison_project_id, generation, row_filter, difference_filter, article_id)
);

CREATE TABLE IF NOT EXISTS mart.comparison_filter_stats (
  comparison_project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  row_filter VARCHAR NOT NULL,
  difference_filter VARCHAR NOT NULL,
  total_count BIGINT NOT NULL,
  stats_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(comparison_project_id, generation, row_filter, difference_filter)
);

CREATE INDEX IF NOT EXISTS idx_app_comparison_project_serving_generation_active
ON app.comparison_project_serving_generation(comparison_project_id, active_generation);

CREATE INDEX IF NOT EXISTS idx_mart_comparison_article_serving_order
ON mart.comparison_article_serving(comparison_project_id, generation, row_sort_created_at, row_sort_title, row_sort_article_id);

CREATE INDEX IF NOT EXISTS idx_mart_comparison_article_identifier_serving_lookup
ON mart.comparison_article_identifier_serving(comparison_project_id, generation, article_id, is_primary, kind, normalized_value, source_identifier_id);

CREATE INDEX IF NOT EXISTS idx_mart_comparison_filter_member_lookup
ON mart.comparison_filter_member(comparison_project_id, generation, row_filter, difference_filter, ordinal, article_id);

CREATE INDEX IF NOT EXISTS idx_mart_comparison_cell_serving_article_lookup
ON mart.comparison_cell_serving(comparison_project_id, generation, article_id, column_order, column_id);

CREATE INDEX IF NOT EXISTS idx_mart_comparison_cell_serving_column_lookup
ON mart.comparison_cell_serving(comparison_project_id, generation, column_id, article_id);

CREATE INDEX IF NOT EXISTS idx_mart_comparison_filter_stats_lookup
ON mart.comparison_filter_stats(comparison_project_id, generation, row_filter, difference_filter);
