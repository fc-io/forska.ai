ALTER TABLE mart.comparison_system_prompt_variant_serving ADD COLUMN IF NOT EXISTS full_text_strategy_id VARCHAR DEFAULT 'fts-none';
