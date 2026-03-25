DROP TABLE IF EXISTS mart.review_article_display;
DROP TABLE IF EXISTS mart.review_article_judgment_payload;
DROP TABLE IF EXISTS mart.review_article_candidate;
DROP TABLE IF EXISTS mart.review_article_judgment_detail;
DROP TABLE IF EXISTS mart.review_article_rollup;
DROP TABLE IF EXISTS mart.prompt_answer_fact;
DROP TABLE IF EXISTS mart.project_scope_article;

CREATE TABLE mart.project_scope_article (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  in_curated_scope BOOLEAN NOT NULL,
  in_route_scope BOOLEAN NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  PRIMARY KEY(project_id, article_id)
);

CREATE TABLE mart.prompt_answer_fact (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  judgment_id VARCHAR NOT NULL,
  model_id VARCHAR NOT NULL,
  answer_value VARCHAR NOT NULL,
  answered_original VARCHAR,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  judgment_created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(project_id, judgment_id, answer_value)
);

CREATE TABLE mart.review_article_rollup (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  enabled_prompt_count INTEGER NOT NULL,
  llm_judged_prompt_count INTEGER NOT NULL,
  human_answered_prompt_count INTEGER NOT NULL,
  llm_judged_prompt_ids VARCHAR[],
  human_answered_prompt_ids VARCHAR[],
  has_all_llm_judgments BOOLEAN NOT NULL,
  has_all_human_answers BOOLEAN NOT NULL,
  in_curated_scope BOOLEAN NOT NULL,
  in_route_scope BOOLEAN NOT NULL,
  review_opened BOOLEAN NOT NULL,
  review_sections_completed INTEGER NOT NULL,
  latest_llm_created_at TIMESTAMPTZ,
  latest_human_updated_at TIMESTAMPTZ,
  latest_review_updated_at TIMESTAMPTZ,
  rollup_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, article_id)
);

CREATE TABLE mart.review_article_judgment_detail (
  project_id VARCHAR NOT NULL,
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
  PRIMARY KEY(project_id, judgment_id)
);

CREATE TABLE mart.review_article_candidate (
  project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_seq BIGINT NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  has_all_llm_judgments BOOLEAN NOT NULL,
  llm_judged_prompt_count INTEGER NOT NULL,
  enabled_prompt_count INTEGER NOT NULL,
  candidate_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, article_id),
  UNIQUE(project_id, article_seq)
);

CREATE INDEX idx_mart_project_scope_article_project_id
ON mart.project_scope_article(project_id, article_created_at, article_id);

CREATE INDEX idx_mart_prompt_answer_fact_lookup
ON mart.prompt_answer_fact(project_id, prompt_id, answer_value, article_id);

CREATE INDEX idx_mart_review_article_rollup_project_id
ON mart.review_article_rollup(project_id, has_all_llm_judgments, article_created_at, article_id);

CREATE INDEX idx_mart_review_article_judgment_detail_project_article
ON mart.review_article_judgment_detail(project_id, article_id, prompt_order, created_at);

CREATE INDEX idx_mart_review_article_candidate_order
ON mart.review_article_candidate(project_id, has_all_llm_judgments, article_created_at, article_seq);
