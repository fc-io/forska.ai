CREATE TABLE IF NOT EXISTS app.review_rebuild_request (
  request_id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  reason VARCHAR NOT NULL,
  requested_components_json JSON NOT NULL DEFAULT '[]',
  source_watermarks_json JSON NOT NULL DEFAULT '{}',
  identity_json JSON NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 100,
  status VARCHAR NOT NULL DEFAULT 'pending_admission',
  admission_state VARCHAR NOT NULL DEFAULT 'pending',
  retry_policy_json JSON NOT NULL DEFAULT '{}',
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after TIMESTAMPTZ,
  oom_category VARCHAR,
  over_budget_reason VARCHAR,
  diagnostics_json JSON NOT NULL DEFAULT '{}',
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  admitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(request_id)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(reason)) > 0),
  CHECK (priority >= 0),
  CHECK (retry_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_review_rebuild_request_status
ON app.review_rebuild_request(project_id, status, admission_state, priority, updated_at);

ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS request_id VARCHAR;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS parent_chunk_id VARCHAR;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS split_depth INTEGER DEFAULT 0;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS snapshot_id VARCHAR;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS snapshot_count INTEGER DEFAULT 1;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS oom_category VARCHAR;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS over_budget_reason VARCHAR;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS estimated_input_rows BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS max_input_rows BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS actual_input_rows BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS estimated_output_rows BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS max_output_rows BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS actual_output_rows BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS estimated_output_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS max_output_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS actual_output_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS estimated_payload_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS max_payload_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS actual_payload_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS estimated_prompt_count BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS max_prompt_count BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS actual_prompt_count BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS estimated_temp_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS max_temp_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS actual_temp_bytes BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS duration_ms BIGINT;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS workload_class VARCHAR;
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS admission_state VARCHAR DEFAULT 'admitted';
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS budget_json JSON DEFAULT '{}';
ALTER TABLE app.review_rebuild_chunk_manifest ADD COLUMN IF NOT EXISTS diagnostics_json JSON DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_review_rebuild_chunk_manifest_request_status
ON app.review_rebuild_chunk_manifest(request_id, project_id, projection_component, status, admission_state, retry_after);
