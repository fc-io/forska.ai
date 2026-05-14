ALTER TABLE app.request_attempt_closeout_backfill_state
ADD COLUMN IF NOT EXISTS cursor_created_at TIMESTAMPTZ;

ALTER TABLE app.request_attempt_closeout_backfill_state
ADD COLUMN IF NOT EXISTS cursor_token_use_id VARCHAR;

ALTER TABLE app.request_attempt_closeout_backfill_state
ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

ALTER TABLE app.request_attempt_closeout_backfill_state
ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

ALTER TABLE app.request_attempt_closeout_backfill_state
ADD COLUMN IF NOT EXISTS last_error VARCHAR;
