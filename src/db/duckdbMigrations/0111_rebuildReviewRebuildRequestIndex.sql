DROP TABLE IF EXISTS app.review_rebuild_request_index_repair;

CREATE TABLE app.review_rebuild_request_index_repair (
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

INSERT INTO app.review_rebuild_request_index_repair
SELECT * FROM app.review_rebuild_request;

DROP TABLE app.review_rebuild_request;

ALTER TABLE app.review_rebuild_request_index_repair RENAME TO review_rebuild_request;

CREATE INDEX idx_review_rebuild_request_status
ON app.review_rebuild_request(project_id, status, admission_state, priority, updated_at);
