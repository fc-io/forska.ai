ALTER TABLE app.project ADD COLUMN IF NOT EXISTS delete_pending_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_app_project_delete_pending
ON app.project(delete_pending_at, id);

CREATE TABLE IF NOT EXISTS app.archived_project_delete_tombstone (
  project_id VARCHAR PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  completed_at TIMESTAMPTZ,
  last_cleanup_at TIMESTAMPTZ,
  last_cleanup_phase VARCHAR,
  last_cleanup_table VARCHAR,
  last_deleted_row_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_app_archived_project_delete_tombstone_pending
ON app.archived_project_delete_tombstone(completed_at, requested_at, project_id);
