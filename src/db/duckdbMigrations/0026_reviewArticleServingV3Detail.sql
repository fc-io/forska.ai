ALTER TABLE mart.review_article_serving ADD COLUMN IF NOT EXISTS llm_judged_prompt_ids VARCHAR[];
ALTER TABLE mart.review_article_serving ADD COLUMN IF NOT EXISTS human_answered_prompt_ids VARCHAR[];

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

CREATE INDEX IF NOT EXISTS idx_mart_review_article_serving_detail_lookup
ON mart.review_article_serving_detail(project_id, generation, article_id, prompt_order, created_at);
