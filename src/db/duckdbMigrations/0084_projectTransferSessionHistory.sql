CREATE TABLE IF NOT EXISTS app.project_transfer_session (
  id VARCHAR PRIMARY KEY,
  direction VARCHAR NOT NULL,
  state VARCHAR NOT NULL,
  plan_revision BIGINT NOT NULL DEFAULT 0,
  package_fingerprint VARCHAR,
  commit_id VARCHAR,
  owner_token VARCHAR,
  heartbeat_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  progress_json JSON,
  plan_summary_json JSON,
  completion_payload_json JSON,
  error_json JSON,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(id)) > 0),
  CHECK (direction IN ('import', 'export')),
  CHECK (
    (
      direction = 'import'
      AND state IN (
        'awaiting_upload',
        'uploading',
        'queued',
        'extracting',
        'analyzing',
        'awaiting_resolution',
        'ready_to_commit',
        'committing',
        'completed',
        'failed',
        'cancelled',
        'expired'
      )
    )
    OR (
      direction = 'export'
      AND state IN ('queued', 'assembling', 'packaging', 'ready', 'failed', 'expired')
    )
  ),
  CHECK (plan_revision >= 0),
  CHECK (package_fingerprint IS NULL OR length(trim(package_fingerprint)) > 0),
  CHECK (commit_id IS NULL OR length(trim(commit_id)) > 0),
  CHECK (owner_token IS NULL OR length(trim(owner_token)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_app_project_transfer_session_stale_recovery
ON app.project_transfer_session(direction, state, expires_at, heartbeat_at);

CREATE INDEX IF NOT EXISTS idx_app_project_transfer_session_owner_heartbeat
ON app.project_transfer_session(owner_token, heartbeat_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_app_project_transfer_session_commit
ON app.project_transfer_session(direction, commit_id);

CREATE INDEX IF NOT EXISTS idx_app_project_transfer_session_package
ON app.project_transfer_session(direction, package_fingerprint);

CREATE TABLE IF NOT EXISTS app.project_transfer_history (
  id VARCHAR PRIMARY KEY,
  direction VARCHAR NOT NULL,
  session_id VARCHAR,
  commit_id VARCHAR,
  package_fingerprint VARCHAR NOT NULL,
  schema_version INTEGER NOT NULL,
  source_project_id VARCHAR,
  source_project_name VARCHAR NOT NULL,
  target_project_id VARCHAR,
  target_project_name VARCHAR,
  payload_counts_json JSON NOT NULL,
  completion_payload_json JSON,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(id)) > 0),
  CHECK (direction IN ('import', 'export')),
  CHECK (session_id IS NULL OR length(trim(session_id)) > 0),
  CHECK (commit_id IS NULL OR length(trim(commit_id)) > 0),
  CHECK (length(trim(package_fingerprint)) > 0),
  CHECK (schema_version > 0),
  CHECK (source_project_id IS NULL OR length(trim(source_project_id)) > 0),
  CHECK (length(trim(source_project_name)) > 0),
  CHECK (target_project_id IS NULL OR length(trim(target_project_id)) > 0),
  CHECK (target_project_name IS NULL OR length(trim(target_project_name)) > 0),
  CHECK (
    direction <> 'import'
    OR (
      session_id IS NOT NULL
      AND commit_id IS NOT NULL
      AND target_project_id IS NOT NULL
      AND target_project_name IS NOT NULL
      AND completion_payload_json IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_project_transfer_history_direction_session_unique
ON app.project_transfer_history(direction, session_id);

CREATE INDEX IF NOT EXISTS idx_app_project_transfer_history_duplicate_warning
ON app.project_transfer_history(direction, package_fingerprint, created_at);

CREATE INDEX IF NOT EXISTS idx_app_project_transfer_history_session_completion
ON app.project_transfer_history(direction, session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_app_project_transfer_history_commit
ON app.project_transfer_history(direction, commit_id);
