DROP TABLE IF EXISTS app.review_rebuild_chunk_manifest_noindex_repair;

CREATE TABLE app.review_rebuild_chunk_manifest_noindex_repair (
  chunk_id VARCHAR NOT NULL,
  project_id VARCHAR,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  input_digest VARCHAR,
  input_watermark BIGINT NOT NULL DEFAULT 0,
  chunk_start_key VARCHAR NOT NULL,
  chunk_end_key VARCHAR NOT NULL,
  output_base_generation BIGINT NOT NULL DEFAULT 0,
  status VARCHAR NOT NULL DEFAULT 'pending',
  checksum VARCHAR,
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  last_error VARCHAR,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  request_id VARCHAR,
  parent_chunk_id VARCHAR,
  split_depth INTEGER DEFAULT 0,
  snapshot_id VARCHAR,
  snapshot_count INTEGER DEFAULT 1,
  retry_count INTEGER DEFAULT 0,
  retry_after TIMESTAMPTZ,
  oom_category VARCHAR,
  over_budget_reason VARCHAR,
  estimated_input_rows BIGINT,
  max_input_rows BIGINT,
  actual_input_rows BIGINT,
  estimated_output_rows BIGINT,
  max_output_rows BIGINT,
  actual_output_rows BIGINT,
  estimated_output_bytes BIGINT,
  max_output_bytes BIGINT,
  actual_output_bytes BIGINT,
  estimated_payload_bytes BIGINT,
  max_payload_bytes BIGINT,
  actual_payload_bytes BIGINT,
  estimated_prompt_count BIGINT,
  max_prompt_count BIGINT,
  actual_prompt_count BIGINT,
  estimated_temp_bytes BIGINT,
  max_temp_bytes BIGINT,
  actual_temp_bytes BIGINT,
  duration_ms BIGINT,
  workload_class VARCHAR,
  admission_state VARCHAR DEFAULT 'admitted',
  budget_json JSON DEFAULT '{}',
  diagnostics_json JSON DEFAULT '{}'
);

INSERT INTO app.review_rebuild_chunk_manifest_noindex_repair BY NAME
SELECT * FROM app.review_rebuild_chunk_manifest;

DROP TABLE app.review_rebuild_chunk_manifest;

ALTER TABLE app.review_rebuild_chunk_manifest_noindex_repair RENAME TO review_rebuild_chunk_manifest;
