DROP TABLE IF EXISTS app.review_serving_projector_watermark_repair;

CREATE TABLE app.review_serving_projector_watermark_repair (
  watermark_id VARCHAR NOT NULL,
  projector_name VARCHAR NOT NULL,
  project_id VARCHAR,
  import_route_id VARCHAR,
  projection_component VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  source_high_water_mark BIGINT NOT NULL DEFAULT 0,
  base_generation BIGINT NOT NULL DEFAULT 0,
  patch_watermark BIGINT NOT NULL DEFAULT 0,
  snapshot_id VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'ready',
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  cursor_json JSON,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(watermark_id)) > 0),
  CHECK (length(trim(projector_name)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (source_high_water_mark >= 0),
  CHECK (base_generation >= 0),
  CHECK (patch_watermark >= 0)
);

INSERT INTO app.review_serving_projector_watermark_repair
SELECT
  watermark_id,
  any_value(projector_name) AS projector_name,
  any_value(project_id) AS project_id,
  any_value(import_route_id) AS import_route_id,
  any_value(projection_component) AS projection_component,
  any_value(source_partition) AS source_partition,
  MAX(source_high_water_mark) AS source_high_water_mark,
  MAX(base_generation) AS base_generation,
  MAX(patch_watermark) AS patch_watermark,
  any_value(snapshot_id) AS snapshot_id,
  any_value(status) AS status,
  any_value(lease_owner) AS lease_owner,
  any_value(lease_expires_at) AS lease_expires_at,
  any_value(cursor_json) AS cursor_json,
  any_value(last_error) AS last_error,
  MIN(created_at) AS created_at,
  MAX(updated_at) AS updated_at
FROM app.review_serving_projector_watermark
GROUP BY watermark_id;

DROP TABLE app.review_serving_projector_watermark;

ALTER TABLE app.review_serving_projector_watermark_repair RENAME TO review_serving_projector_watermark;

CREATE INDEX IF NOT EXISTS idx_review_serving_projector_watermark_lookup
ON app.review_serving_projector_watermark(projector_name, project_id, projection_component, source_high_water_mark);
