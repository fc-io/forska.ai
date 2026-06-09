CREATE TEMP TABLE project_model_fk_project_backup AS
SELECT * FROM app.project;

CREATE TEMP TABLE project_model_fk_judgment_backup AS
SELECT * FROM app.judgment;

CREATE TEMP TABLE project_model_fk_judgment_assessment_backup AS
SELECT * FROM app.judgment_assessment;

DROP INDEX IF EXISTS app.idx_app_project_delete_pending;
DROP INDEX IF EXISTS app.idx_app_judgment_lookup;

DROP TABLE app.judgment_assessment;
DROP TABLE app.judgment;
DROP TABLE app.project;

CREATE TABLE app.project (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  model_id VARCHAR NOT NULL,
  use_title BOOLEAN NOT NULL DEFAULT TRUE,
  use_abstract BOOLEAN NOT NULL DEFAULT TRUE,
  use_fulltext BOOLEAN NOT NULL DEFAULT FALSE,
  use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE,
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  human_judgment_mode human_judgment_mode DEFAULT 'prompt',
  delete_pending_at TIMESTAMPTZ
);

CREATE TABLE app.judgment (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  model_id VARCHAR NOT NULL,
  project_id VARCHAR,
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

INSERT INTO app.project BY NAME
SELECT * FROM project_model_fk_project_backup;

INSERT INTO app.judgment BY NAME
SELECT * FROM project_model_fk_judgment_backup;

INSERT INTO app.judgment_assessment BY NAME
SELECT * FROM project_model_fk_judgment_assessment_backup;

DROP TABLE project_model_fk_project_backup;
DROP TABLE project_model_fk_judgment_backup;
DROP TABLE project_model_fk_judgment_assessment_backup;

CREATE INDEX IF NOT EXISTS idx_app_project_delete_pending
ON app.project(delete_pending_at, id);

CREATE INDEX IF NOT EXISTS idx_app_judgment_lookup
ON app.judgment(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation);
