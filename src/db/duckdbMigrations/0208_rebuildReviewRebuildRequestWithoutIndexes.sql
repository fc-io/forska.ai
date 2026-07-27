DROP TABLE IF EXISTS app.review_rebuild_request_noindex_repair;

CREATE TABLE app.review_rebuild_request_noindex_repair (
  request_id VARCHAR NOT NULL,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO app.review_rebuild_request_noindex_repair BY NAME
SELECT * FROM app.review_rebuild_request;

DROP TABLE app.review_rebuild_request;

ALTER TABLE app.review_rebuild_request_noindex_repair RENAME TO review_rebuild_request;
