-- One row per data source whose harvest import (PubMed, Europe PMC PPR, medRxiv,
-- bioRxiv, arXiv) has started since this table exists. The owner uses it to resume
-- imports interrupted by a restart and to retry transient failures with backoff.
-- The resume cursor stays in app.data_source.cursor and is saved in the same
-- transaction as last_progress_at. A separate table keeps app.data_source (indexed)
-- free of ALTERs.

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(data_source_id)) > 0),
  CHECK (length(trim(import_route)) > 0),
  CHECK (status IN ('running', 'failed', 'completed')),
  CHECK (run_trigger IN ('manual', 'auto_resume', 'auto_retry')),
  CHECK (consecutive_failure_count >= 0)
);
