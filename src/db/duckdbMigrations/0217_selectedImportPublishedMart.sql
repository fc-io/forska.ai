CREATE TABLE IF NOT EXISTS mart.review_selected_article_import_current_v4 (
  project_id VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  selected_import_snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  import_route_id VARCHAR,
  source_record_key VARCHAR,
  selected_rank_key VARCHAR,
  selected_rank_numeric DOUBLE,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO mart.review_selected_article_import_current_v4 (
  project_id,
  project_scope_identity,
  selected_import_snapshot_id,
  article_id,
  import_route_id,
  source_record_key,
  selected_rank_key,
  selected_rank_numeric,
  tombstone,
  selected_import_updated_at
)
SELECT
  legacy.project_id,
  legacy.project_scope_identity,
  legacy.selected_import_snapshot_id,
  legacy.article_id,
  legacy.import_route_id,
  legacy.source_record_key,
  legacy.selected_rank_key,
  legacy.selected_rank_numeric,
  legacy.tombstone,
  legacy.selected_import_updated_at
FROM app.review_selected_article_import_v4 legacy
WHERE NOT EXISTS (
  SELECT 1
  FROM mart.review_selected_article_import_current_v4 published
  WHERE published.project_id = legacy.project_id
    AND published.project_scope_identity = legacy.project_scope_identity
    AND published.selected_import_snapshot_id = legacy.selected_import_snapshot_id
    AND published.article_id = legacy.article_id
)
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY
    legacy.project_id,
    legacy.project_scope_identity,
    legacy.selected_import_snapshot_id,
    legacy.article_id
  ORDER BY
    legacy.selected_import_updated_at DESC,
    legacy.import_route_id ASC NULLS LAST,
    legacy.source_record_key ASC NULLS LAST,
    legacy.selected_rank_key ASC NULLS LAST,
    legacy.selected_rank_numeric ASC NULLS LAST,
    legacy.tombstone ASC
) = 1;
