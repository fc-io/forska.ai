CREATE TABLE IF NOT EXISTS app.comparison_judgment_context (
  id VARCHAR PRIMARY KEY,
  context_json JSON NOT NULL,
  prompt_ids VARCHAR[] NOT NULL,
  model_ids VARCHAR[] NOT NULL,
  system_prompt_variants VARCHAR[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS mart.comparison_judgment_context_serving (
  comparison_project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  judgment_context_id VARCHAR NOT NULL,
  context_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

ALTER TABLE app.comparison_project_conflict_resolution ADD COLUMN IF NOT EXISTS judgment_context_id VARCHAR;
ALTER TABLE app.comparison_project_conflict_resolution ADD COLUMN IF NOT EXISTS serving_generation BIGINT;
ALTER TABLE app.comparison_project_conflict_resolution ADD COLUMN IF NOT EXISTS reviewer_display_name VARCHAR;
ALTER TABLE app.comparison_project_conflict_resolution ADD COLUMN IF NOT EXISTS origin VARCHAR;
ALTER TABLE app.comparison_project_conflict_resolution ADD COLUMN IF NOT EXISTS origin_ref VARCHAR;

UPDATE app.comparison_project_conflict_resolution
SET reviewer_display_name = NULLIF(TRIM(reviewer.name), '')
FROM app.user_config reviewer
WHERE reviewer.id = app.comparison_project_conflict_resolution.reviewer_user_id
  AND app.comparison_project_conflict_resolution.reviewer_display_name IS NULL
  AND NULLIF(TRIM(reviewer.name), '') IS NOT NULL;
