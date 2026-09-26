DROP TABLE IF EXISTS app.review_selected_import_snapshot_noindex_repair_0243;

CREATE TABLE app.review_selected_import_snapshot_noindex_repair_0243 (
  selected_import_snapshot_id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  source_delta_high_water BIGINT NOT NULL DEFAULT 0,
  cursor_json JSON,
  status VARCHAR NOT NULL DEFAULT 'candidate',
  owner VARCHAR,
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(selected_import_snapshot_id)) > 0),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(project_scope_identity)) > 0),
  CHECK (source_delta_high_water >= 0)
);

INSERT INTO app.review_selected_import_snapshot_noindex_repair_0243 BY NAME
SELECT * FROM app.review_selected_import_snapshot;

DROP TABLE app.review_selected_import_snapshot;

ALTER TABLE app.review_selected_import_snapshot_noindex_repair_0243
RENAME TO review_selected_import_snapshot;
