ALTER TABLE app.review_serving_dirty_work
ADD COLUMN IF NOT EXISTS lifecycle_reason VARCHAR;

ALTER TABLE app.review_serving_dirty_work
ADD COLUMN IF NOT EXISTS projection_component VARCHAR;

ALTER TABLE app.review_serving_dirty_work
ADD COLUMN IF NOT EXISTS projection_identity VARCHAR;

CREATE TABLE IF NOT EXISTS app.review_serving_dirty_work_claim_state (
  dirty_work_id VARCHAR PRIMARY KEY,
  storage_row_id BIGINT,
  project_id VARCHAR NOT NULL,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  latest_source_high_water_mark BIGINT NOT NULL,
  dirty_range_start VARCHAR,
  dirty_range_end VARCHAR,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(dirty_work_id)) > 0),
  CHECK (project_id = '' OR length(trim(project_id)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(projection_identity)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (length(trim(status)) > 0),
  CHECK (latest_source_high_water_mark >= 0)
);
