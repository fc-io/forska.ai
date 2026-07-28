DROP TABLE IF EXISTS app.review_serving_dirty_work_ack_noindex_repair_0211;

CREATE TABLE app.review_serving_dirty_work_ack_noindex_repair_0211 (
  dirty_ack_id VARCHAR NOT NULL,
  dirty_work_id VARCHAR,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  completed_source_high_water_mark BIGINT NOT NULL,
  dirty_range_start VARCHAR,
  dirty_range_end VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'completed',
  completed_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(dirty_ack_id)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(projection_identity)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (completed_source_high_water_mark >= 0)
);

INSERT INTO app.review_serving_dirty_work_ack_noindex_repair_0211 BY NAME
SELECT * FROM app.review_serving_dirty_work_ack;

DROP INDEX IF EXISTS app.idx_review_serving_dirty_work_ack_component;
DROP INDEX IF EXISTS idx_review_serving_dirty_work_ack_component;

DROP TABLE app.review_serving_dirty_work_ack;

ALTER TABLE app.review_serving_dirty_work_ack_noindex_repair_0211
RENAME TO review_serving_dirty_work_ack;
