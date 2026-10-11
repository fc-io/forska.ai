ALTER TABLE app.judgment_job ADD COLUMN IF NOT EXISTS stop_after_articles INTEGER;
ALTER TABLE app.judgment_job ADD COLUMN IF NOT EXISTS stop_when_human_answered_done BOOLEAN DEFAULT FALSE;
ALTER TABLE app.judgment_job ADD COLUMN IF NOT EXISTS stop_after_total_tokens BIGINT;
ALTER TABLE app.judgment_job ADD COLUMN IF NOT EXISTS stop_at TIMESTAMPTZ;
ALTER TABLE app.judgment_job ADD COLUMN IF NOT EXISTS stop_reason VARCHAR;
ALTER TABLE app.judgment_job ADD COLUMN IF NOT EXISTS stop_reason_at TIMESTAMPTZ;
