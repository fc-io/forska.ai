CREATE TABLE IF NOT EXISTS mart.review_article_page (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_title VARCHAR NOT NULL,
  journal_title VARCHAR,
  has_all_llm_judgments BOOLEAN NOT NULL,
  llm_judged_prompt_count INTEGER NOT NULL,
  enabled_prompt_count INTEGER NOT NULL,
  page_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_page_project_id
ON mart.review_article_page(project_id, has_all_llm_judgments, article_created_at, article_id);
