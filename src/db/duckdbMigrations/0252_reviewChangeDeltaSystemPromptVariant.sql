ALTER TABLE app.review_change_delta ADD COLUMN IF NOT EXISTS system_prompt_variant VARCHAR DEFAULT 'legacy';
