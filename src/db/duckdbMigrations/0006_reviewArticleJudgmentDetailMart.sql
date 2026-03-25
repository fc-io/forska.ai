CREATE TABLE IF NOT EXISTS mart.review_article_judgment_detail (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  prompt_order INTEGER,
  judgment_id VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  article_title VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_import_route VARCHAR,
  model_id VARCHAR NOT NULL,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  explanation VARCHAR,
  quotes JSON,
  PRIMARY KEY(project_id, judgment_id)
);

CREATE INDEX IF NOT EXISTS idx_mart_review_article_judgment_detail_project_article
ON mart.review_article_judgment_detail(project_id, article_id, prompt_order, created_at);
