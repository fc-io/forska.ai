ALTER TABLE app.judgment_job ADD COLUMN IF NOT EXISTS full_text_strategy_id VARCHAR;
ALTER TABLE app.judgment_execution_snapshot ADD COLUMN IF NOT EXISTS full_text_strategy_id VARCHAR DEFAULT 'fts-none';
