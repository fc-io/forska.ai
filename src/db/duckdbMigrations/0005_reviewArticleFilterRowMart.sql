CREATE TABLE IF NOT EXISTS mart.review_article_filter_row (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  answer_value VARCHAR NOT NULL,
  numeric_answer_value BIGINT,
  filter_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, article_id, prompt_id, answer_value)
);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_filter_row_text
ON mart.review_article_filter_row(project_id, prompt_id, answer_value, article_id);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_filter_row_numeric
ON mart.review_article_filter_row(project_id, prompt_id, numeric_answer_value, article_id);
