CREATE TABLE IF NOT EXISTS app.article_merge (
  merged_article_id VARCHAR PRIMARY KEY,
  target_article_id VARCHAR NOT NULL,
  import_route_id VARCHAR NOT NULL,
  base_import_route_id VARCHAR NOT NULL,
  match_tier VARCHAR NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  article_deleted_at TIMESTAMPTZ
);
