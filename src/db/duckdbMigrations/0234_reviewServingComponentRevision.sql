CREATE TABLE IF NOT EXISTS app.review_serving_component_revision (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  source_high_water_mark BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(snapshot_id)) > 0),
  CHECK (length(trim(list_mode_key)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(projection_identity)) > 0),
  CHECK (revision >= 0),
  CHECK (source_high_water_mark >= 0)
);
