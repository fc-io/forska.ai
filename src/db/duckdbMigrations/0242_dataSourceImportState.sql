-- One row per data source whose harvest import (PubMed, Europe PMC PPR, medRxiv,
-- bioRxiv, arXiv) has started since this table exists. The owner uses it to resume
-- imports interrupted by a restart and to retry transient failures with backoff.
-- The resume cursor stays in app.data_source.cursor and is saved in the same
-- transaction as last_progress_at and the progress counts. total_count is the
-- provider's hit count (Europe PMC) or NULL when the provider reports none;
-- fetched/stored counts add up across resumes and reset on a fresh start;
-- progress_from_start is FALSE when a resume had no earlier counts to build on.
-- A separate table keeps app.data_source (indexed) free of ALTERs.

CREATE TABLE IF NOT EXISTS app.data_source_import_state (
  data_source_id VARCHAR PRIMARY KEY,
  import_route VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  run_trigger VARCHAR NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  run_started_at TIMESTAMPTZ NOT NULL,
  last_progress_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  next_retry_at TIMESTAMPTZ,
  total_count BIGINT,
  fetched_count BIGINT NOT NULL DEFAULT 0,
  stored_count BIGINT NOT NULL DEFAULT 0,
  run_start_fetched_count BIGINT NOT NULL DEFAULT 0,
  run_start_stored_count BIGINT NOT NULL DEFAULT 0,
  progress_from_start BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(data_source_id)) > 0),
  CHECK (length(trim(import_route)) > 0),
  CHECK (status IN ('running', 'failed', 'completed')),
  CHECK (run_trigger IN ('manual', 'auto_resume', 'auto_retry')),
  CHECK (consecutive_failure_count >= 0),
  CHECK (total_count IS NULL OR total_count >= 0),
  CHECK (fetched_count >= 0),
  CHECK (stored_count >= 0),
  CHECK (run_start_fetched_count >= 0),
  CHECK (run_start_stored_count >= 0)
);
