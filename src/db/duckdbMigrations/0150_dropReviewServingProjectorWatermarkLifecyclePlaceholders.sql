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

INSERT INTO app.review_serving_projector_watermark_repair (
  watermark_id,
  projector_name,
  project_id,
  import_route_id,
  projection_component,
  source_partition,
  source_high_water_mark,
  base_generation,
  patch_watermark,
  created_at,
  updated_at
)
SELECT
  watermark_id,
  projector_name,
  project_id,
  import_route_id,
  projection_component,
  source_partition,
  source_high_water_mark,
  base_generation,
  patch_watermark,
  created_at,
  updated_at
FROM app.review_serving_projector_watermark;

DROP TABLE app.review_serving_projector_watermark;

ALTER TABLE app.review_serving_projector_watermark_repair RENAME TO review_serving_projector_watermark;
