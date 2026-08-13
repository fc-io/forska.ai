DROP TABLE IF EXISTS app.review_serving_dirty_work_noindex_repair_0222;

CREATE TABLE app.review_serving_dirty_work_noindex_repair_0222 (
  dirty_work_id VARCHAR NOT NULL,
  project_id VARCHAR,
  scope_kind VARCHAR NOT NULL,
  scope_id VARCHAR NOT NULL,
  article_id VARCHAR,
  projection_key VARCHAR,
  projection_component VARCHAR,
  projection_identity VARCHAR,
  dirty_kind VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  first_source_high_water_mark BIGINT NOT NULL,
  latest_source_high_water_mark BIGINT NOT NULL,
  latest_delta_id VARCHAR,
  dirty_range_start VARCHAR,
  dirty_range_end VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'pending',
  lifecycle_reason VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(dirty_work_id)) > 0),
  CHECK (length(trim(scope_kind)) > 0),
  CHECK (length(trim(scope_id)) > 0),
  CHECK (length(trim(dirty_kind)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (first_source_high_water_mark >= 0),
  CHECK (latest_source_high_water_mark >= first_source_high_water_mark)
);

INSERT INTO app.review_serving_dirty_work_noindex_repair_0222 BY NAME
SELECT * FROM app.review_serving_dirty_work;

DROP INDEX IF EXISTS app.idx_review_serving_dirty_work_lookup;
DROP INDEX IF EXISTS idx_review_serving_dirty_work_lookup;
DROP INDEX IF EXISTS app.idx_review_serving_dirty_work_id_lookup;
DROP INDEX IF EXISTS idx_review_serving_dirty_work_id_lookup;
DROP INDEX IF EXISTS app.idx_review_serving_dirty_work_ack_id_lookup;
DROP INDEX IF EXISTS idx_review_serving_dirty_work_ack_id_lookup;

DROP TABLE app.review_serving_dirty_work;

ALTER TABLE app.review_serving_dirty_work_noindex_repair_0222
RENAME TO review_serving_dirty_work;
