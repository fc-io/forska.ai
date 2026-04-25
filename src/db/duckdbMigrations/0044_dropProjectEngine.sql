CREATE TEMP TABLE project_drop_engine_project_backup AS
SELECT
  id,
  name,
  description,
  model_id,
  human_judgment_mode,
  use_title,
  use_abstract,
  use_fulltext,
  use_fulltext_no_images,
  date_from,
  date_to,
  archived,
  created_at,
  updated_at
FROM app.project;

CREATE TEMP TABLE project_drop_engine_project_prompt_backup AS
SELECT * FROM app.project_prompt;

CREATE TEMP TABLE project_drop_engine_project_import_route_backup AS
SELECT * FROM app.project_import_route;

CREATE TEMP TABLE project_drop_engine_project_article_backup AS
SELECT * FROM app.project_article;

CREATE TEMP TABLE project_drop_engine_judgment_job_backup AS
SELECT * FROM app.judgment_job;

CREATE TEMP TABLE project_drop_engine_judgment_backup AS
SELECT * FROM app.judgment;

CREATE TEMP TABLE project_drop_engine_judgment_assessment_backup AS
SELECT * FROM app.judgment_assessment;

CREATE TEMP TABLE project_drop_engine_judgment_human_backup AS
SELECT * FROM app.judgment_human;

CREATE TEMP TABLE project_drop_engine_judgment_human_summary_backup AS
SELECT * FROM app.judgment_human_summary;

CREATE TEMP TABLE project_drop_engine_review_backup AS
SELECT * FROM app.review;

CREATE TEMP TABLE project_drop_engine_project_mart_refresh_state_backup AS
SELECT * FROM app.project_mart_refresh_state;

CREATE TEMP TABLE project_drop_engine_project_mart_refresh_article_state_backup AS
SELECT * FROM app.project_mart_refresh_article_state;

CREATE TEMP TABLE project_drop_engine_project_mart_large_rebuild_state_backup AS
SELECT * FROM app.project_mart_large_rebuild_state;

CREATE TEMP TABLE project_drop_engine_comparison_project_backup AS
SELECT * FROM app.comparison_project;

CREATE TEMP TABLE project_drop_engine_comparison_project_prompt_backup AS
SELECT * FROM app.comparison_project_prompt;

CREATE TEMP TABLE project_drop_engine_comparison_project_import_route_backup AS
SELECT * FROM app.comparison_project_import_route;

CREATE TEMP TABLE project_drop_engine_comparison_project_source_project_backup AS
SELECT * FROM app.comparison_project_source_project;

DROP TABLE app.comparison_project_prompt;
DROP TABLE app.comparison_project_import_route;
DROP TABLE app.comparison_project_source_project;
DROP TABLE app.comparison_project;
DROP TABLE app.judgment_assessment;
DROP TABLE app.judgment;
DROP TABLE app.judgment_human;
DROP TABLE app.judgment_human_summary;
DROP TABLE app.judgment_job;
DROP TABLE app.project_mart_refresh_article_state;
DROP TABLE app.project_mart_refresh_state;
DROP TABLE app.project_mart_large_rebuild_state;
DROP TABLE app.review;
DROP TABLE app.project_prompt;
DROP TABLE app.project_import_route;
DROP TABLE app.project_article;
DROP TABLE app.project;

CREATE TABLE app.project (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  model_id VARCHAR NOT NULL REFERENCES app.model(id),
  use_title BOOLEAN NOT NULL DEFAULT TRUE,
  use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
  use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
  use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  human_judgment_mode human_judgment_mode DEFAULT 'prompt'
);

CREATE TABLE app.project_prompt (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  prompt_order INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  origin_project_id VARCHAR REFERENCES app.project(id),
  criteria_disposition project_prompt_criteria_disposition_v2,
  criteria_section_key VARCHAR,
  criteria_section_label VARCHAR,
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
  storage_state VARCHAR NOT NULL DEFAULT 'active',
  quarantined_at TIMESTAMPTZ,
  quarantine_reason VARCHAR,
  last_import_started_at TIMESTAMPTZ,
  last_import_completed_at TIMESTAMPTZ,
  last_import_error_at TIMESTAMPTZ,
  last_import_error VARCHAR,
  last_import_exit_code INTEGER,
  import_failure_count INTEGER NOT NULL DEFAULT 0,
  pause_requested_at TIMESTAMPTZ,
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

CREATE TABLE app.judgment_assessment (
  id VARCHAR PRIMARY KEY,
  judgment_id VARCHAR NOT NULL REFERENCES app.judgment(id),
  assessment_is_correct BOOLEAN NOT NULL,
  assessment_comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(judgment_id)
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

CREATE TABLE app.judgment_human_summary (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  answer VARCHAR CHECK (answer IN ('yes', 'no', 'maybe') OR answer IS NULL),
  origin VARCHAR NOT NULL CHECK (origin IN ('covidence_import', 'manual_override')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id)
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

CREATE TABLE app.project_mart_refresh_state (
  project_id VARCHAR PRIMARY KEY REFERENCES app.project(id),
  dirty_token BIGINT NOT NULL DEFAULT 0,
  active_refresh_token BIGINT NOT NULL DEFAULT 0,
  last_completed_refresh_token BIGINT NOT NULL DEFAULT 0,
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  last_request_reason VARCHAR,
  requested_by VARCHAR,
  refresh_status VARCHAR NOT NULL DEFAULT 'idle',
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  last_error VARCHAR,
  worker_id VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE app.project_mart_refresh_article_state (
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  first_dirty_token BIGINT NOT NULL,
  last_dirty_token BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (project_id, article_id),
  CHECK (first_dirty_token <= last_dirty_token)
);

CREATE TABLE app.project_mart_large_rebuild_state (
  project_id VARCHAR PRIMARY KEY REFERENCES app.project(id),
  refresh_token BIGINT NOT NULL DEFAULT 0,
  rebuild_phase VARCHAR NOT NULL DEFAULT 'judgment_fact',
  cursor_article_created_at TIMESTAMPTZ,
  cursor_article_id VARCHAR,
  target_generation BIGINT,
  refresh_status VARCHAR NOT NULL DEFAULT 'idle',
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  last_error VARCHAR,
  operator_note VARCHAR,
  worker_id VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE app.comparison_project (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  model_ids VARCHAR[],
  compare_with_humans BOOLEAN NOT NULL DEFAULT FALSE,
  human_judgment_mode human_judgment_mode DEFAULT 'prompt',
  summary_source_project_id VARCHAR REFERENCES app.project(id),
  use_title BOOLEAN NOT NULL DEFAULT TRUE,
  use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
  use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
  use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE app.comparison_project_prompt (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL REFERENCES app.comparison_project(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  prompt_order INTEGER,
  criteria_disposition project_prompt_criteria_disposition_v2,
  criteria_section_key VARCHAR,
  criteria_section_label VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, prompt_id)
);

CREATE TABLE app.comparison_project_import_route (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL REFERENCES app.comparison_project(id),
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, import_route_id)
);

CREATE TABLE app.comparison_project_source_project (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL REFERENCES app.comparison_project(id),
  source_project_id VARCHAR NOT NULL REFERENCES app.project(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, source_project_id)
);

INSERT INTO app.project (
  id,
  name,
  description,
  model_id,
  human_judgment_mode,
  use_title,
  use_abstract,
  use_fulltext,
  use_fulltext_no_images,
  date_from,
  date_to,
  archived,
  created_at,
  updated_at
)
SELECT
  id,
  name,
  description,
  model_id,
  human_judgment_mode,
  use_title,
  use_abstract,
  use_fulltext,
  use_fulltext_no_images,
  date_from,
  date_to,
  archived,
  created_at,
  updated_at
FROM project_drop_engine_project_backup;

INSERT INTO app.project_prompt BY NAME SELECT * FROM project_drop_engine_project_prompt_backup;
INSERT INTO app.project_import_route BY NAME SELECT * FROM project_drop_engine_project_import_route_backup;
INSERT INTO app.project_article BY NAME SELECT * FROM project_drop_engine_project_article_backup;
INSERT INTO app.judgment_job BY NAME SELECT * FROM project_drop_engine_judgment_job_backup;
INSERT INTO app.judgment BY NAME SELECT * FROM project_drop_engine_judgment_backup;
INSERT INTO app.judgment_assessment BY NAME SELECT * FROM project_drop_engine_judgment_assessment_backup;
INSERT INTO app.judgment_human BY NAME SELECT * FROM project_drop_engine_judgment_human_backup;
INSERT INTO app.judgment_human_summary BY NAME SELECT * FROM project_drop_engine_judgment_human_summary_backup;
INSERT INTO app.review BY NAME SELECT * FROM project_drop_engine_review_backup;
INSERT INTO app.project_mart_refresh_state BY NAME SELECT * FROM project_drop_engine_project_mart_refresh_state_backup;
INSERT INTO app.project_mart_refresh_article_state BY NAME SELECT * FROM project_drop_engine_project_mart_refresh_article_state_backup;
INSERT INTO app.project_mart_large_rebuild_state BY NAME SELECT * FROM project_drop_engine_project_mart_large_rebuild_state_backup;
INSERT INTO app.comparison_project BY NAME SELECT * FROM project_drop_engine_comparison_project_backup;
INSERT INTO app.comparison_project_prompt BY NAME SELECT * FROM project_drop_engine_comparison_project_prompt_backup;
INSERT INTO app.comparison_project_import_route BY NAME SELECT * FROM project_drop_engine_comparison_project_import_route_backup;
INSERT INTO app.comparison_project_source_project BY NAME SELECT * FROM project_drop_engine_comparison_project_source_project_backup;

CREATE INDEX IF NOT EXISTS idx_app_project_prompt_project_id ON app.project_prompt(project_id, prompt_id);
CREATE INDEX IF NOT EXISTS idx_app_project_article_project_id ON app.project_article(project_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_judgment_human_summary_project_id ON app.judgment_human_summary(project_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_judgment_human_summary_article_id ON app.judgment_human_summary(article_id, project_id);
