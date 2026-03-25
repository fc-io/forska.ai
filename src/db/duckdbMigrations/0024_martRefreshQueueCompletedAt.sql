ALTER TABLE app.mart_refresh_queue ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
