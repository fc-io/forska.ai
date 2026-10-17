ALTER TABLE app.project ADD COLUMN IF NOT EXISTS full_text_figure_mode VARCHAR;
ALTER TABLE app.project ADD COLUMN IF NOT EXISTS full_text_chunk_policy JSON;
ALTER TABLE app.project ADD COLUMN IF NOT EXISTS full_text_strategy_id VARCHAR;
UPDATE app.project
SET full_text_figure_mode = 'none'
WHERE (use_fulltext = TRUE OR use_fulltext_no_images = TRUE)
  AND full_text_figure_mode IS NULL;
UPDATE app.project
SET full_text_strategy_id = 'fts-legacy-v0'
WHERE (use_fulltext = TRUE OR use_fulltext_no_images = TRUE)
  AND full_text_strategy_id IS NULL;
CREATE TABLE IF NOT EXISTS app.full_text_strategy (
  id VARCHAR PRIMARY KEY,
  label VARCHAR NOT NULL,
  inputs JSON NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
