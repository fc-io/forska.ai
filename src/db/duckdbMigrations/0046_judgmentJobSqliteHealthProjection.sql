CREATE TABLE IF NOT EXISTS app.judgment_job_sqlite_health_projection (
  job_id VARCHAR PRIMARY KEY,
  projection_source VARCHAR NOT NULL,
  projected_by VARCHAR,
  projected_at TIMESTAMPTZ NOT NULL,
  fresh_until_at TIMESTAMPTZ NOT NULL,
  has_outbox_rows BOOLEAN NOT NULL DEFAULT FALSE,
  has_queue_rows BOOLEAN NOT NULL DEFAULT FALSE,
  outbox_row_count INTEGER NOT NULL DEFAULT 0,
  claimed_outbox_count INTEGER NOT NULL DEFAULT 0,
  oldest_unexported_age_ms BIGINT,
  orphaned_judged_row_count INTEGER NOT NULL DEFAULT 0,
  retained_row_count INTEGER NOT NULL DEFAULT 0,
  last_ack_seq BIGINT,
  pending_completion_ack_count INTEGER NOT NULL DEFAULT 0,
  has_pending_completion_ack BOOLEAN NOT NULL DEFAULT FALSE,
  oldest_unacked_completion_age_ms BIGINT,
  sqlite_file_bytes BIGINT,
  wal_bytes BIGINT NOT NULL DEFAULT 0,
  prompt_ready_count INTEGER NOT NULL DEFAULT 0,
  prompt_claimed_count INTEGER NOT NULL DEFAULT 0,
  prompt_running_count INTEGER NOT NULL DEFAULT 0,
  prompt_judged_count INTEGER NOT NULL DEFAULT 0,
  prompt_skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_app_judgment_job_sqlite_health_projection_fresh
ON app.judgment_job_sqlite_health_projection(fresh_until_at, job_id);
