DROP TABLE IF EXISTS app.review_projection_identity_manifest_noindex_repair_0225;

CREATE TABLE app.review_projection_identity_manifest_noindex_repair_0225 (
  manifest_id VARCHAR NOT NULL,
  project_id VARCHAR,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  base_generation BIGINT NOT NULL DEFAULT 0,
  patch_watermark BIGINT NOT NULL DEFAULT 0,
  patch_range_start BIGINT,
  patch_range_end BIGINT,
  input_watermark BIGINT NOT NULL DEFAULT 0,
  input_watermarks_json JSON NOT NULL DEFAULT '{}',
  input_digest VARCHAR,
  definition_version VARCHAR NOT NULL,
  review_config_hash VARCHAR,
  prompt_config_hash VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'candidate',
  invalidation_reason VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO app.review_projection_identity_manifest_noindex_repair_0225 BY NAME
SELECT * FROM app.review_projection_identity_manifest;

DROP TABLE app.review_projection_identity_manifest;

ALTER TABLE app.review_projection_identity_manifest_noindex_repair_0225
RENAME TO review_projection_identity_manifest;

DROP TABLE IF EXISTS app.review_serving_snapshot_manifest_noindex_repair_0225;

CREATE TABLE app.review_serving_snapshot_manifest_noindex_repair_0225 (
  project_id VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  snapshot_status VARCHAR NOT NULL DEFAULT 'candidate',
  review_config_hash VARCHAR,
  composed_identity_json JSON NOT NULL,
  component_state_json JSON NOT NULL,
  required_components_json JSON NOT NULL,
  optional_components_json JSON NOT NULL,
  source_watermarks_json JSON NOT NULL,
  validation_result_json JSON,
  selected_import_snapshot_id VARCHAR,
  last_known_good_snapshot_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  activated_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  last_error VARCHAR
);

INSERT INTO app.review_serving_snapshot_manifest_noindex_repair_0225 BY NAME
SELECT * FROM app.review_serving_snapshot_manifest;

DROP TABLE app.review_serving_snapshot_manifest;

ALTER TABLE app.review_serving_snapshot_manifest_noindex_repair_0225
RENAME TO review_serving_snapshot_manifest;
