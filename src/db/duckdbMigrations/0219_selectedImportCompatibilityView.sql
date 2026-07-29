DROP TABLE IF EXISTS app.review_selected_article_import_v4;

CREATE VIEW app.review_selected_article_import_v4 AS
SELECT
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
FROM mart.review_selected_article_import_current_v4;
