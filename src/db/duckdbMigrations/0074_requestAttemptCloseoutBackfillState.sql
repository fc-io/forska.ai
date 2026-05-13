CREATE TABLE IF NOT EXISTS app.request_attempt_closeout_backfill_state (
  id VARCHAR PRIMARY KEY,
  high_water_created_at TIMESTAMPTZ,
  high_water_token_use_id VARCHAR,
  scanned BIGINT NOT NULL DEFAULT 0,
  attempted BIGINT NOT NULL DEFAULT 0,
  projected BIGINT NOT NULL DEFAULT 0,
  batches BIGINT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  CHECK (length(trim(id)) > 0)
);
