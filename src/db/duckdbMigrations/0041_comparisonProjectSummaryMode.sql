CREATE TEMP TABLE comparison_project_summary_mode_project_backup AS
SELECT * FROM app.comparison_project;

CREATE TEMP TABLE comparison_project_summary_mode_prompt_backup AS
SELECT * FROM app.comparison_project_prompt;

CREATE TEMP TABLE comparison_project_summary_mode_import_route_backup AS
SELECT * FROM app.comparison_project_import_route;

DROP TABLE app.comparison_project_prompt;

DROP TABLE app.comparison_project_import_route;

DROP TABLE app.comparison_project;

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
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
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

INSERT INTO app.comparison_project (
  id,
  name,
  description,
  model_ids,
  compare_with_humans,
  human_judgment_mode,
  summary_source_project_id,
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
  model_ids,
  compare_with_humans,
  'prompt',
  NULL,
  use_title,
  use_abstract,
  use_fulltext,
  use_fulltext_no_images,
  date_from,
  date_to,
  archived,
  created_at,
  updated_at
FROM comparison_project_summary_mode_project_backup;

INSERT INTO app.comparison_project_prompt (
  id,
  comparison_project_id,
  prompt_id,
  prompt_order,
  criteria_disposition,
  criteria_section_key,
  criteria_section_label,
  created_at,
  updated_at
)
SELECT
  id,
  comparison_project_id,
  prompt_id,
  prompt_order,
  NULL,
  NULL,
  NULL,
  created_at,
  updated_at
FROM comparison_project_summary_mode_prompt_backup;

INSERT INTO app.comparison_project_import_route (
  id,
  comparison_project_id,
  import_route_id,
  created_at,
  updated_at
)
SELECT
  id,
  comparison_project_id,
  import_route_id,
  created_at,
  updated_at
FROM comparison_project_summary_mode_import_route_backup;
