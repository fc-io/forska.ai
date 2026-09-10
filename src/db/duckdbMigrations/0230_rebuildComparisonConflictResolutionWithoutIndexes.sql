DROP TABLE IF EXISTS app.comparison_project_conflict_resolution_noindex_repair_0230;

CREATE TABLE app.comparison_project_conflict_resolution_noindex_repair_0230 (
  id VARCHAR NOT NULL,
  comparison_project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR,
  answer_value VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  reviewer_user_id VARCHAR
);

INSERT INTO app.comparison_project_conflict_resolution_noindex_repair_0230 BY NAME
SELECT *
FROM app.comparison_project_conflict_resolution
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY comparison_project_id, article_id
  ORDER BY
    updated_at DESC NULLS LAST,
    created_at DESC NULLS LAST,
    id DESC
) = 1;

DROP INDEX IF EXISTS app.idx_app_comparison_project_conflict_resolution_lookup;
DROP INDEX IF EXISTS idx_app_comparison_project_conflict_resolution_lookup;

DROP TABLE app.comparison_project_conflict_resolution;

ALTER TABLE app.comparison_project_conflict_resolution_noindex_repair_0230
RENAME TO comparison_project_conflict_resolution;
