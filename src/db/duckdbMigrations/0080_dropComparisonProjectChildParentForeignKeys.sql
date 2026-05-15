CREATE TEMP TABLE comparison_project_child_parent_fk_prompt_backup AS
SELECT * FROM app.comparison_project_prompt;

CREATE TEMP TABLE comparison_project_child_parent_fk_import_route_backup AS
SELECT * FROM app.comparison_project_import_route;

CREATE TEMP TABLE comparison_project_child_parent_fk_source_project_backup AS
SELECT * FROM app.comparison_project_source_project;

CREATE TEMP TABLE comparison_project_child_parent_fk_conflict_resolution_backup AS
SELECT * FROM app.comparison_project_conflict_resolution;

DROP INDEX IF EXISTS app.idx_app_comparison_project_conflict_resolution_lookup;

DROP TABLE app.comparison_project_conflict_resolution;
DROP TABLE app.comparison_project_prompt;
DROP TABLE app.comparison_project_import_route;
DROP TABLE app.comparison_project_source_project;

CREATE TABLE app.comparison_project_prompt (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL,
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
  comparison_project_id VARCHAR NOT NULL,
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, import_route_id)
);

CREATE TABLE app.comparison_project_source_project (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL,
  source_project_id VARCHAR NOT NULL REFERENCES app.project(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, source_project_id)
);

CREATE TABLE app.comparison_project_conflict_resolution (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  prompt_id VARCHAR REFERENCES app.prompt(id),
  answer_value VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(comparison_project_id, article_id)
);

INSERT INTO app.comparison_project_prompt BY NAME
SELECT * FROM comparison_project_child_parent_fk_prompt_backup;

INSERT INTO app.comparison_project_import_route BY NAME
SELECT * FROM comparison_project_child_parent_fk_import_route_backup;

INSERT INTO app.comparison_project_source_project BY NAME
SELECT * FROM comparison_project_child_parent_fk_source_project_backup;

INSERT INTO app.comparison_project_conflict_resolution BY NAME
SELECT * FROM comparison_project_child_parent_fk_conflict_resolution_backup;

DROP TABLE comparison_project_child_parent_fk_prompt_backup;
DROP TABLE comparison_project_child_parent_fk_import_route_backup;
DROP TABLE comparison_project_child_parent_fk_source_project_backup;
DROP TABLE comparison_project_child_parent_fk_conflict_resolution_backup;

CREATE INDEX IF NOT EXISTS idx_app_comparison_project_conflict_resolution_lookup
ON app.comparison_project_conflict_resolution(comparison_project_id, article_id);
