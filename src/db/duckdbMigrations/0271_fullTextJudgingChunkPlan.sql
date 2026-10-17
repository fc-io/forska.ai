CREATE TABLE IF NOT EXISTS app.article_full_text_chunk_plan (
  article_id VARCHAR NOT NULL,
  full_text_strategy_id VARCHAR NOT NULL,
  plan_hash VARCHAR NOT NULL,
  text_hash VARCHAR NOT NULL,
  chunk_count INTEGER NOT NULL,
  chunks JSON NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (article_id, full_text_strategy_id)
);

ALTER TABLE app.judgment ADD COLUMN IF NOT EXISTS full_text_mode VARCHAR;

ALTER TABLE app.judgment ADD COLUMN IF NOT EXISTS chunk_count INTEGER;

ALTER TABLE app.judgment ADD COLUMN IF NOT EXISTS chunk_plan_hash VARCHAR;
