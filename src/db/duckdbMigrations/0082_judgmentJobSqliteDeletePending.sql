CREATE TABLE IF NOT EXISTS app.judgment_job_sqlite_delete_pending (
  job_id VARCHAR PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  last_attempt_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_app_judgment_job_sqlite_delete_pending_attempt
ON app.judgment_job_sqlite_delete_pending(last_attempt_at, requested_at);
