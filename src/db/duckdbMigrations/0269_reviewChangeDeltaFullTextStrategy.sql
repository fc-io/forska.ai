ALTER TABLE app.review_change_delta ADD COLUMN IF NOT EXISTS full_text_strategy_id VARCHAR DEFAULT 'fts-none';
