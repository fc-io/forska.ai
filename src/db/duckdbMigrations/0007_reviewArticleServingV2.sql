CREATE TABLE IF NOT EXISTS app.project_article_ordinal (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_seq BIGINT NOT NULL,
  ordinal_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, article_id),
  UNIQUE(project_id, article_seq)
);

CREATE TABLE IF NOT EXISTS app.review_answer_dictionary (
  project_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  answer_id INTEGER NOT NULL,
  answer_value VARCHAR NOT NULL,
  numeric_answer_value BIGINT,
  dictionary_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, prompt_id, answer_id),
  UNIQUE(project_id, prompt_id, answer_value)
);

CREATE TABLE IF NOT EXISTS mart.review_article_candidate (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_seq BIGINT NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_title VARCHAR NOT NULL,
  has_all_llm_judgments BOOLEAN NOT NULL,
  llm_judged_prompt_count INTEGER NOT NULL,
  enabled_prompt_count INTEGER NOT NULL,
  candidate_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, article_id),
  UNIQUE(project_id, article_seq)
);

CREATE TABLE IF NOT EXISTS mart.review_article_display (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_external_id VARCHAR,
  article_title VARCHAR NOT NULL,
  journal_title VARCHAR,
  url VARCHAR,
  full_text_pdf VARCHAR,
  full_text_fetched_at TIMESTAMPTZ,
  full_text_conversion_status VARCHAR,
  display_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, article_id)
);

CREATE TABLE IF NOT EXISTS mart.review_article_filter_posting (
  project_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  answer_id INTEGER NOT NULL,
  article_seq_list BIGINT[],
  article_count BIGINT NOT NULL,
  posting_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, prompt_id, answer_id)
);

CREATE TABLE IF NOT EXISTS mart.review_article_judgment_payload (
  project_id VARCHAR NOT NULL,
  judgment_id VARCHAR NOT NULL,
  explanation VARCHAR,
  quotes JSON,
  payload_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, judgment_id)
);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_candidate_order
ON mart.review_article_candidate(project_id, has_all_llm_judgments, article_created_at, article_seq);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_display_project
ON mart.review_article_display(project_id, article_id);

CREATE INDEX IF NOT EXISTS idx_app_review_answer_dictionary_lookup
ON app.review_answer_dictionary(project_id, prompt_id, answer_value, answer_id);
