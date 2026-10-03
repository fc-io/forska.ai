CREATE TABLE IF NOT EXISTS app.judgment_job_provider_health (
  job_id VARCHAR PRIMARY KEY,
  model_id VARCHAR,
  status VARCHAR NOT NULL,
  failure_kind VARCHAR NOT NULL,
  failure_code VARCHAR,
  failure_message VARCHAR,
  retry_after_at TIMESTAMPTZ,
  first_failed_at TIMESTAMPTZ NOT NULL,
  last_failed_at TIMESTAMPTZ NOT NULL,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  total_failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
