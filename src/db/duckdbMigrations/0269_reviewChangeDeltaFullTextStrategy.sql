ALTER TABLE app.review_change_delta ADD COLUMN IF NOT EXISTS full_text_strategy_id VARCHAR DEFAULT 'fts-none';
UPDATE app.review_change_delta
SET full_text_strategy_id = 'fts-legacy-v0'
WHERE use_fulltext OR use_fulltext_no_images;
