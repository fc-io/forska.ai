CREATE TEMP TABLE article_import_route_backup AS
SELECT * FROM app.article_import_route;

CREATE TEMP TABLE project_article_backup AS
SELECT * FROM app.project_article;

CREATE TEMP TABLE judgment_job_prompt_backup AS
SELECT * FROM app.judgment_job_prompt;

CREATE TEMP TABLE judgment_backup AS
SELECT * FROM app.judgment;

CREATE TEMP TABLE judgment_human_backup AS
SELECT * FROM app.judgment_human;

CREATE TEMP TABLE judgment_assessment_backup AS
SELECT * FROM app.judgment_assessment;

CREATE TEMP TABLE review_backup AS
SELECT * FROM app.review;

DROP TABLE app.article_import_route;
DROP TABLE app.project_article;
DROP TABLE app.judgment_job_prompt;
DROP TABLE app.judgment_assessment;
DROP TABLE app.judgment;
DROP TABLE app.judgment_human;
DROP TABLE app.review;

DROP INDEX IF EXISTS app.idx_app_article_article_id;

ALTER TABLE app.article DROP COLUMN IF EXISTS openalex_id;

CREATE TABLE app.article_import_route (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(article_id, import_route_id)
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

CREATE TABLE app.judgment_job_prompt (
  id VARCHAR PRIMARY KEY,
  job_id VARCHAR NOT NULL REFERENCES app.judgment_job(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  server_id VARCHAR,
  sent_at TIMESTAMPTZ,
  judged_at TIMESTAMPTZ,
  status VARCHAR NOT NULL DEFAULT 'ready',
  skip_reason VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(article_id, prompt_id, job_id)
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
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id),
  is_answered BOOLEAN NOT NULL DEFAULT FALSE,
  answer VARCHAR,
  "comment" VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(project_id, article_id, prompt_id)
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

INSERT INTO app.article_import_route
SELECT * FROM article_import_route_backup;

INSERT INTO app.project_article
SELECT * FROM project_article_backup;

INSERT INTO app.judgment_job_prompt
SELECT * FROM judgment_job_prompt_backup;

INSERT INTO app.judgment
SELECT * FROM judgment_backup;

INSERT INTO app.judgment_human
SELECT * FROM judgment_human_backup;

INSERT INTO app.judgment_assessment
SELECT * FROM judgment_assessment_backup;

INSERT INTO app.review
SELECT * FROM review_backup;

CREATE INDEX IF NOT EXISTS idx_app_article_article_id ON app.article(article_id);
CREATE INDEX IF NOT EXISTS idx_app_article_import_route_import_route_id ON app.article_import_route(import_route_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_project_article_project_id ON app.project_article(project_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_judgment_lookup ON app.judgment(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation);
CREATE INDEX IF NOT EXISTS idx_app_judgment_human_lookup ON app.judgment_human(project_id, article_id, prompt_id);
