CREATE TABLE IF NOT EXISTS mart.review_selected_article_import_staging_v4 (
  staging_row_id VARCHAR NOT NULL,
  project_id VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  selected_import_snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  import_route_id VARCHAR,
  source_record_key VARCHAR,
  selected_rank_key VARCHAR,
  selected_rank_numeric DOUBLE,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  projection_identity VARCHAR NOT NULL,
  source_delta_high_water BIGINT NOT NULL,
  source_partition VARCHAR NOT NULL,
  publish_scope_key VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  published_at TIMESTAMPTZ
);
