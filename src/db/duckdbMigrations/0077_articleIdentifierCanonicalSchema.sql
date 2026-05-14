CREATE TEMP TABLE us002_article_backup AS
SELECT * FROM app.article;

CREATE TEMP TABLE us002_article_import_route_backup AS
SELECT * FROM app.article_import_route;

CREATE TEMP TABLE us002_project_article_backup AS
SELECT * FROM app.project_article;

CREATE TEMP TABLE us002_judgment_backup AS
SELECT * FROM app.judgment;

CREATE TEMP TABLE us002_judgment_assessment_backup AS
SELECT * FROM app.judgment_assessment;

CREATE TEMP TABLE us002_judgment_human_backup AS
SELECT * FROM app.judgment_human;

CREATE TEMP TABLE us002_review_backup AS
SELECT * FROM app.review;

CREATE TEMP TABLE us002_judgment_human_summary_backup AS
SELECT * FROM app.judgment_human_summary;

CREATE TEMP TABLE us002_project_mart_refresh_article_state_backup AS
SELECT * FROM app.project_mart_refresh_article_state;

CREATE TEMP TABLE us002_project_mart_dirty_refresh_article_quarantine_backup AS
SELECT * FROM app.project_mart_dirty_refresh_article_quarantine;

CREATE TEMP TABLE us002_comparison_project_conflict_resolution_backup AS
SELECT * FROM app.comparison_project_conflict_resolution;

DROP INDEX IF EXISTS app.idx_app_article_article_id;
DROP INDEX IF EXISTS app.idx_app_article_import_route_import_route_id;
DROP INDEX IF EXISTS app.idx_app_project_article_project_id;
DROP INDEX IF EXISTS app.idx_app_judgment_human_summary_project_id;
DROP INDEX IF EXISTS app.idx_app_judgment_human_summary_article_id;
DROP INDEX IF EXISTS app.idx_app_project_mart_refresh_article_state_dirty_range;
DROP INDEX IF EXISTS app.idx_app_project_mart_dirty_refresh_article_quarantine_barrier;
DROP INDEX IF EXISTS app.idx_app_project_mart_dirty_refresh_article_quarantine_updated_at;
DROP INDEX IF EXISTS app.idx_app_comparison_project_conflict_resolution_lookup;

DROP TABLE app.judgment_assessment;
DROP TABLE app.article_import_route;
DROP TABLE app.project_article;
DROP TABLE app.judgment;
DROP TABLE app.judgment_human;
DROP TABLE app.review;
DROP TABLE app.judgment_human_summary;
DROP TABLE app.project_mart_refresh_article_state;
DROP TABLE app.project_mart_dirty_refresh_article_quarantine;
DROP TABLE app.comparison_project_conflict_resolution;
DROP TABLE app.article;

CREATE TABLE app.article (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR,
  article_title VARCHAR NOT NULL,
  article_summary VARCHAR,
  article_authors VARCHAR[],
  article_version INTEGER,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  arxiv_id VARCHAR,
  biorxiv_id VARCHAR,
  medrxiv_id VARCHAR,
  doi VARCHAR,
  pubmed_id VARCHAR,
  url VARCHAR,
  full_text VARCHAR,
  full_text_html VARCHAR,
  full_text_pdf VARCHAR,
  full_text_source VARCHAR,
  full_text_original_format VARCHAR,
  full_text_fetched_at TIMESTAMPTZ,
  full_text_assets JSON,
  full_text_conversion_status VARCHAR,
  full_text_conversion_error VARCHAR,
  full_text_conversion_attempts INTEGER,
  full_text_conversion_model_id VARCHAR,
  full_text_conversion_metadata JSON,
  full_text_char_count BIGINT,
  content_hash VARCHAR,
  import_route VARCHAR,
  original_data JSON,
  publication_status VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  source_metadata JSON
);

INSERT INTO app.article (
  id,
  article_id,
  article_title,
  article_summary,
  article_authors,
  article_version,
  article_created_at,
  article_updated_at,
  arxiv_id,
  biorxiv_id,
  medrxiv_id,
  doi,
  pubmed_id,
  url,
  full_text,
  full_text_html,
  full_text_pdf,
  full_text_source,
  full_text_original_format,
  full_text_fetched_at,
  full_text_assets,
  full_text_conversion_status,
  full_text_conversion_error,
  full_text_conversion_attempts,
  full_text_conversion_model_id,
  full_text_conversion_metadata,
  full_text_char_count,
  content_hash,
  import_route,
  original_data,
  publication_status,
  created_at,
  updated_at,
  source_metadata
)
SELECT
  id,
  article_id,
  article_title,
  article_summary,
  article_authors,
  article_version,
  article_created_at,
  article_updated_at,
  arxiv_id,
  biorxiv_id,
  medrxiv_id,
  doi,
  pubmed_id,
  url,
  full_text,
  full_text_html,
  full_text_pdf,
  full_text_source,
  full_text_original_format,
  full_text_fetched_at,
  full_text_assets,
  full_text_conversion_status,
  full_text_conversion_error,
  full_text_conversion_attempts,
  full_text_conversion_model_id,
  full_text_conversion_metadata,
  full_text_char_count,
  content_hash,
  import_route,
  original_data,
  publication_status,
  created_at,
  updated_at,
  source_metadata
FROM us002_article_backup;

CREATE TABLE app.article_identifier (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  kind VARCHAR NOT NULL CHECK (kind IN ('doi', 'pmid', 'arxiv')),
  normalized_value VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  provenance JSON,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(kind, normalized_value)
);

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
  "comment" VARCHAR,
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

CREATE TABLE app.project_mart_dirty_refresh_article_quarantine (
  project_id VARCHAR NOT NULL REFERENCES app.project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  dirty_token BIGINT NOT NULL,
  error VARCHAR NOT NULL,
  detected_by VARCHAR,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (project_id, article_id, dirty_token)
);

CREATE TABLE app.comparison_project_conflict_resolution (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL REFERENCES app.comparison_project(id),
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR REFERENCES app.prompt(id),
  answer_value VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, article_id)
);

INSERT INTO app.article_import_route
SELECT * FROM us002_article_import_route_backup;

INSERT INTO app.project_article
SELECT * FROM us002_project_article_backup;

INSERT INTO app.judgment
SELECT * FROM us002_judgment_backup;

INSERT INTO app.judgment_assessment
SELECT * FROM us002_judgment_assessment_backup;

INSERT INTO app.judgment_human
SELECT * FROM us002_judgment_human_backup;

INSERT INTO app.review
SELECT * FROM us002_review_backup;

INSERT INTO app.judgment_human_summary
SELECT * FROM us002_judgment_human_summary_backup;

INSERT INTO app.project_mart_refresh_article_state
SELECT * FROM us002_project_mart_refresh_article_state_backup;

INSERT INTO app.project_mart_dirty_refresh_article_quarantine
SELECT * FROM us002_project_mart_dirty_refresh_article_quarantine_backup;

INSERT INTO app.comparison_project_conflict_resolution
SELECT * FROM us002_comparison_project_conflict_resolution_backup;

CREATE INDEX IF NOT EXISTS idx_app_article_article_id ON app.article(article_id);
CREATE INDEX IF NOT EXISTS idx_app_article_identifier_article_id ON app.article_identifier(article_id, kind);
CREATE INDEX IF NOT EXISTS idx_app_article_import_route_import_route_id ON app.article_import_route(import_route_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_project_article_project_id ON app.project_article(project_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_judgment_human_summary_project_id ON app.judgment_human_summary(project_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_judgment_human_summary_article_id ON app.judgment_human_summary(article_id, project_id);
CREATE INDEX IF NOT EXISTS idx_app_project_mart_refresh_article_state_dirty_range ON app.project_mart_refresh_article_state(project_id, last_dirty_token, first_dirty_token);
CREATE INDEX IF NOT EXISTS idx_app_project_mart_dirty_refresh_article_quarantine_barrier ON app.project_mart_dirty_refresh_article_quarantine(project_id, resolved_at, dirty_token);
CREATE INDEX IF NOT EXISTS idx_app_project_mart_dirty_refresh_article_quarantine_updated_at ON app.project_mart_dirty_refresh_article_quarantine(updated_at, project_id, article_id);
CREATE INDEX IF NOT EXISTS idx_app_comparison_project_conflict_resolution_lookup ON app.comparison_project_conflict_resolution(comparison_project_id, article_id);

CREATE VIEW app.article_legacy_id_lookup AS
SELECT
  article_id AS legacy_article_id,
  id AS article_id,
  created_at,
  updated_at
FROM app.article
WHERE article_id IS NOT NULL;
