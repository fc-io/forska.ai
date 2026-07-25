DROP TABLE IF EXISTS mart.review_title_search_serving_v4_repair;

CREATE TABLE mart.review_title_search_serving_v4_repair (
  project_id VARCHAR NOT NULL,
  search_identity VARCHAR NOT NULL,
  project_scope_identity VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  token VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL
);

INSERT INTO mart.review_title_search_serving_v4_repair
SELECT
  project_id,
  search_identity,
  project_scope_identity,
  snapshot_id,
  token,
  article_id
FROM mart.review_title_search_serving_v4;

DROP TABLE mart.review_title_search_serving_v4;

ALTER TABLE mart.review_title_search_serving_v4_repair RENAME TO review_title_search_serving_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_title_search_serving_v4_repaired_pk
ON mart.review_title_search_serving_v4(project_id, search_identity, project_scope_identity, snapshot_id, token, article_id);

CREATE INDEX IF NOT EXISTS idx_review_title_search_serving_v4_token
ON mart.review_title_search_serving_v4(project_id, search_identity, project_scope_identity, snapshot_id, token, article_id);
