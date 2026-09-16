ALTER TABLE app.data_source
ADD COLUMN IF NOT EXISTS tracking_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE app.data_source
ADD COLUMN IF NOT EXISTS tracking_reconcile_schedule_months JSON NOT NULL DEFAULT '[3,12,24,36]';

CREATE TABLE IF NOT EXISTS app.data_source_tracking_state (
  data_source_id VARCHAR PRIMARY KEY REFERENCES app.data_source(id),
  route VARCHAR NOT NULL,
  granularity VARCHAR NOT NULL,
  high_water_completed_at TIMESTAMPTZ,
  active_window_start TIMESTAMPTZ,
  active_window_end TIMESTAMPTZ,
  active_cursor VARCHAR,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  next_run_after TIMESTAMPTZ,
  last_reconciliation_scheduler_at TIMESTAMPTZ,
  last_reconciliation_completed_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  active_run_kind VARCHAR,
  active_reconciliation_age_months INTEGER,
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  last_import_run_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(data_source_id)) > 0),
  CHECK (length(trim(route)) > 0),
  CHECK (granularity IN ('day', 'hour', 'minute', 'cursor')),
  CHECK (failure_count >= 0),
  CHECK (active_run_kind IS NULL OR active_run_kind IN ('incremental', 'reconciliation'))
);

CREATE TABLE IF NOT EXISTS app.data_source_reconciliation_work (
  id VARCHAR PRIMARY KEY,
  data_source_id VARCHAR NOT NULL REFERENCES app.data_source(id),
  route VARCHAR NOT NULL,
  run_kind VARCHAR NOT NULL,
  age_months INTEGER,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  spool_window_id VARCHAR,
  cursor VARCHAR,
  status VARCHAR NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  next_retry_at TIMESTAMPTZ,
  lease_owner VARCHAR,
  lease_expires_at TIMESTAMPTZ,
  import_run_id VARCHAR,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(data_source_id, run_kind, age_months, period_start, period_end),
  CHECK (length(trim(id)) > 0),
  CHECK (length(trim(data_source_id)) > 0),
  CHECK (length(trim(route)) > 0),
  CHECK (run_kind IN ('automatic_age_bucket', 'manual_full_range')),
  CHECK (
    (run_kind = 'automatic_age_bucket' AND age_months IS NOT NULL)
    OR (run_kind = 'manual_full_range' AND age_months IS NULL)
  ),
  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CHECK (failure_count >= 0),
  CHECK (period_start < period_end)
);

CREATE TABLE IF NOT EXISTS app.data_source_article_change_log (
  id VARCHAR PRIMARY KEY,
  data_source_id VARCHAR NOT NULL REFERENCES app.data_source(id),
  route VARCHAR NOT NULL,
  import_route_id VARCHAR,
  article_id VARCHAR,
  external_article_id VARCHAR,
  source_record_key VARCHAR,
  change_kind VARCHAR NOT NULL,
  previous_source_record_hash VARCHAR,
  next_source_record_hash VARCHAR,
  changed_fields JSON,
  previous_snapshot JSON,
  next_snapshot JSON,
  import_run_id VARCHAR,
  run_kind VARCHAR NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(id)) > 0),
  CHECK (length(trim(data_source_id)) > 0),
  CHECK (length(trim(route)) > 0),
  CHECK (
    change_kind IN (
      'article_added',
      'source_record_changed',
      'canonical_article_changed',
      'source_record_deleted',
      'source_record_restored'
    )
  ),
  CHECK (run_kind IN ('incremental', 'automatic_age_bucket', 'manual_full_range'))
);

CREATE INDEX IF NOT EXISTS idx_data_source_article_change_log_timeline
ON app.data_source_article_change_log(data_source_id, detected_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_data_source_article_change_log_source_record_history
ON app.data_source_article_change_log(data_source_id, route, change_kind, source_record_key, detected_at, created_at, id);
