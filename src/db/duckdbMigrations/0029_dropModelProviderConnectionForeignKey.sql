CREATE TEMP TABLE provider_connection_fk_model_backup AS
SELECT * FROM app.model;

CREATE TEMP TABLE provider_connection_fk_project_backup AS
SELECT * FROM app.project;

CREATE TEMP TABLE provider_connection_fk_project_prompt_backup AS
SELECT * FROM app.project_prompt;

CREATE TEMP TABLE provider_connection_fk_project_import_route_backup AS
SELECT * FROM app.project_import_route;

CREATE TEMP TABLE provider_connection_fk_project_article_backup AS
SELECT * FROM app.project_article;

CREATE TEMP TABLE provider_connection_fk_judgment_job_backup AS
SELECT * FROM app.judgment_job;

CREATE TEMP TABLE provider_connection_fk_judgment_backup AS
SELECT * FROM app.judgment;

CREATE TEMP TABLE provider_connection_fk_judgment_human_backup AS
SELECT * FROM app.judgment_human;

CREATE TEMP TABLE provider_connection_fk_review_backup AS
SELECT * FROM app.review;

CREATE TEMP TABLE provider_connection_fk_token_use_backup AS
SELECT * FROM app.token_use;

CREATE TEMP TABLE provider_connection_fk_judgment_assessment_backup AS
SELECT * FROM app.judgment_assessment;

DROP TABLE app.judgment_assessment;
DROP TABLE app.token_use;
DROP TABLE app.review;
DROP TABLE app.judgment_human;
DROP TABLE app.judgment;
DROP TABLE app.project_prompt;
DROP TABLE app.project_import_route;
DROP TABLE app.project_article;
DROP TABLE app.judgment_job;
DROP TABLE app.project;
DROP TABLE app.model;

CREATE TABLE app.model (
  id VARCHAR PRIMARY KEY,
  provider_connection_id VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  remote_model_id VARCHAR,
  display_name VARCHAR,
  variant VARCHAR,
  source VARCHAR,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSON,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE app.project (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  engine VARCHAR,
  model_id VARCHAR NOT NULL REFERENCES app.model(id),
  use_title BOOLEAN NOT NULL DEFAULT TRUE,
  use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
  use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
  use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE app.project_prompt (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  prompt_order INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  origin_project_id VARCHAR REFERENCES app.project(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, prompt_id)
);

CREATE TABLE app.project_import_route (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, import_route_id)
);

CREATE TABLE app.project_article (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  imported_from_project_id VARCHAR REFERENCES app.project(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id)
);

CREATE TABLE app.judgment_job (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  status VARCHAR NOT NULL,
  error JSON,
  send_to_llm_batch_size INTEGER NOT NULL DEFAULT 5,
  send_to_llm_interval INTEGER NOT NULL DEFAULT 15,
  cursor_last_created_at TIMESTAMPTZ,
  cursor_last_article_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE app.judgment (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  model_id VARCHAR NOT NULL REFERENCES app.model(id),
  project_id VARCHAR REFERENCES app.project(id),
  snapshot_project_id VARCHAR,
  snapshot_project_model_name VARCHAR,
  use_title BOOLEAN NOT NULL DEFAULT TRUE,
  use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
  use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
  use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
  chunking_strategy VARCHAR,
  is_answered BOOLEAN NOT NULL DEFAULT FALSE,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  confidence_original INTEGER NOT NULL DEFAULT 50,
  explanation VARCHAR,
  quotes JSON,
  delete_generation BIGINT NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation)
);

CREATE TABLE app.judgment_human (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  is_answered BOOLEAN NOT NULL DEFAULT FALSE,
  answer VARCHAR,
  comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id, prompt_id)
);

CREATE TABLE app.review (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  opened BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_title BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_title_comment VARCHAR,
  reviewed_abstract BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_abstract_comment VARCHAR,
  reviewed_intro BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_intro_comment VARCHAR,
  reviewed_method BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_method_comment VARCHAR,
  reviewed_results BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_results_comment VARCHAR,
  reviewed_discussion BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_discussion_comment VARCHAR,
  reviewed_conclusion BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_conclusion_comment VARCHAR,
  reviewed_appendix BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_appendix_comment VARCHAR,
  reviewed_other BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_other_comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id)
);

CREATE TABLE app.token_use (
  id VARCHAR PRIMARY KEY,
  judgment_job_id VARCHAR REFERENCES app.judgment_job(id),
  requests INTEGER NOT NULL,
  total_prompt_tokens BIGINT NOT NULL,
  total_completion_tokens BIGINT NOT NULL,
  total_tokens BIGINT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration BIGINT,
  gpu_nnodes INTEGER,
  gpu_gpus_per_node INTEGER,
  gpu_total_gpus INTEGER,
  tp_size INTEGER,
  dp_size INTEGER,
  gpu_shape VARCHAR,
  sglang_max_running_requests INTEGER,
  sglang_model VARCHAR,
  successful_requests INTEGER,
  failed_requests INTEGER,
  has_failed_requests BOOLEAN,
  failed_requests_details JSON,
  total_success_prompt_tokens BIGINT,
  total_success_completion_tokens BIGINT,
  total_success_tokens BIGINT,
  total_failed_prompt_tokens BIGINT,
  total_failed_completion_tokens BIGINT,
  total_failed_tokens BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE app.judgment_assessment (
  id VARCHAR PRIMARY KEY,
  judgment_id VARCHAR NOT NULL REFERENCES app.judgment(id),
  assessment_is_correct BOOLEAN NOT NULL,
  assessment_comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(judgment_id)
);

INSERT INTO app.model
SELECT * FROM provider_connection_fk_model_backup;

INSERT INTO app.project
SELECT * FROM provider_connection_fk_project_backup;

INSERT INTO app.project_prompt
SELECT * FROM provider_connection_fk_project_prompt_backup;

INSERT INTO app.project_import_route
SELECT * FROM provider_connection_fk_project_import_route_backup;

INSERT INTO app.project_article
SELECT * FROM provider_connection_fk_project_article_backup;

INSERT INTO app.judgment_job
SELECT * FROM provider_connection_fk_judgment_job_backup;

INSERT INTO app.judgment
SELECT * FROM provider_connection_fk_judgment_backup;

INSERT INTO app.judgment_human
SELECT * FROM provider_connection_fk_judgment_human_backup;

INSERT INTO app.review
SELECT * FROM provider_connection_fk_review_backup;

INSERT INTO app.token_use
SELECT * FROM provider_connection_fk_token_use_backup;

INSERT INTO app.judgment_assessment
SELECT * FROM provider_connection_fk_judgment_assessment_backup;

CREATE INDEX IF NOT EXISTS idx_app_project_prompt_project_id ON app.project_prompt(project_id, prompt_id);
CREATE INDEX IF NOT EXISTS idx_app_project_import_route_project_id ON app.project_import_route(project_id, import_route_id);
CREATE INDEX IF NOT EXISTS idx_app_project_article_project_id ON app.project_article(project_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_judgment_lookup ON app.judgment(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation);
CREATE INDEX IF NOT EXISTS idx_app_judgment_human_lookup ON app.judgment_human(project_id, article_id, prompt_id);
