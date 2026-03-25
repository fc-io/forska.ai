CREATE TABLE IF NOT EXISTS app.project_review_serving_generation (
  project_id VARCHAR NOT NULL PRIMARY KEY,
  active_generation BIGINT NOT NULL,
  generation_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS mart.review_article_serving (
  project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_title VARCHAR NOT NULL,
  article_external_id VARCHAR,
  journal_title VARCHAR,
  url VARCHAR,
  full_text_pdf VARCHAR,
  full_text_fetched_at TIMESTAMPTZ,
  full_text_conversion_status VARCHAR,
  source_metadata JSON,
  has_all_llm_judgments BOOLEAN NOT NULL,
  llm_judged_prompt_count INTEGER NOT NULL,
  llm_judged_prompt_ids VARCHAR[],
  enabled_prompt_count INTEGER NOT NULL,
  human_answered_prompt_count INTEGER NOT NULL,
  human_answered_prompt_ids VARCHAR[],
  has_all_human_answers BOOLEAN NOT NULL,
  review_opened BOOLEAN NOT NULL,
  review_sections_completed INTEGER NOT NULL,
  latest_llm_created_at TIMESTAMPTZ,
  latest_human_updated_at TIMESTAMPTZ,
  latest_review_updated_at TIMESTAMPTZ,
  serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, generation, article_id)
);

CREATE TABLE IF NOT EXISTS mart.review_article_filter_member (
  project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  prompt_id VARCHAR NOT NULL,
  answer_id INTEGER NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  numeric_answer_value BIGINT,
  member_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, generation, prompt_id, answer_id, article_id)
);

CREATE TABLE IF NOT EXISTS mart.review_article_serving_detail (
  project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  prompt_order INTEGER,
  judgment_id VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  model_id VARCHAR NOT NULL,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, generation, judgment_id)
);

CREATE INDEX IF NOT EXISTS idx_app_project_review_serving_generation_active
ON app.project_review_serving_generation(project_id, active_generation);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_serving_order
ON mart.review_article_serving(project_id, generation, has_all_llm_judgments, article_created_at, article_id);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_filter_member_lookup
ON mart.review_article_filter_member(project_id, generation, prompt_id, answer_id, article_id);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_serving_detail_lookup
ON mart.review_article_serving_detail(project_id, generation, article_id, prompt_order, created_at);
