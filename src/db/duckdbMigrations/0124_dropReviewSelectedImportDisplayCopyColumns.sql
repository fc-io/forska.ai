DROP TABLE IF EXISTS app.review_selected_article_import_v4_repair;

CREATE TABLE app.review_selected_article_import_v4_repair (
  project_id VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  selected_import_snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  import_route_id VARCHAR,
  source_record_key VARCHAR,
  selected_rank_key VARCHAR,
  selected_rank_numeric DOUBLE,
  duplicate_flag BOOLEAN,
  conflict_flag BOOLEAN,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO app.review_selected_article_import_v4_repair
SELECT
  project_id,
  project_scope_identity,
  selected_import_snapshot_id,
  article_id,
  import_route_id,
  source_record_key,
  selected_rank_key,
  selected_rank_numeric,
  duplicate_flag,
  conflict_flag,
  tombstone,
  selected_import_updated_at
FROM app.review_selected_article_import_v4;

DROP TABLE app.review_selected_article_import_v4;

ALTER TABLE app.review_selected_article_import_v4_repair RENAME TO review_selected_article_import_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_selected_article_import_v4_repaired_pk
ON app.review_selected_article_import_v4(project_id, project_scope_identity, selected_import_snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_selected_article_import_v4_order
ON app.review_selected_article_import_v4(project_id, project_scope_identity, selected_import_snapshot_id, selected_rank_key, article_id);
