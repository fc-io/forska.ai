DROP INDEX IF EXISTS mart.idx_review_article_serving_payload_v4_lookup;
DROP INDEX IF EXISTS idx_review_article_serving_payload_v4_lookup;
DROP INDEX IF EXISTS mart.idx_review_article_serving_payload_v4_repaired_pk;
DROP INDEX IF EXISTS idx_review_article_serving_payload_v4_repaired_pk;
DROP TABLE IF EXISTS mart.review_article_serving_payload_v4_display_repair;

CREATE TABLE mart.review_article_serving_payload_v4_display_repair (
  project_id VARCHAR NOT NULL,
  display_identity VARCHAR NOT NULL,
  payload_identity VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  article_title VARCHAR,
  article_external_id VARCHAR,
  article_updated_at TIMESTAMPTZ,
  arxiv_id VARCHAR,
  biorxiv_id VARCHAR,
  medrxiv_id VARCHAR,
  doi VARCHAR,
  pmid VARCHAR,
  journal_title VARCHAR,
  url VARCHAR,
  abstract_text VARCHAR
);

INSERT INTO mart.review_article_serving_payload_v4_display_repair
WITH payload_rows AS (
  SELECT
    payload.project_id,
    payload.display_identity,
    payload.payload_identity,
    payload.snapshot_id,
    payload.article_id,
    payload.abstract_text,
    snapshot.selected_import_snapshot_id
  FROM mart.review_article_serving_payload_v4 payload
  LEFT JOIN app.review_serving_snapshot_manifest snapshot
    ON snapshot.project_id = payload.project_id
   AND snapshot.snapshot_id = payload.snapshot_id
),
hydrated_rows AS (
  SELECT
    payload.project_id,
    payload.display_identity,
    payload.payload_identity,
    payload.snapshot_id,
    payload.article_id,
    COALESCE(
      CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_hot.article_title
      END,
      article.article_title
    ) AS article_title,
    COALESCE(
      CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_hot.external_id
      END,
      article.article_id
    ) AS article_external_id,
    article.article_updated_at,
    article.arxiv_id,
    article.biorxiv_id,
    article.medrxiv_id,
    article.doi,
    article.pubmed_id AS pmid,
    CASE
      WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
      ELSE selected_hot.journal_title
    END AS journal_title,
    COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url,
    payload.abstract_text,
    ROW_NUMBER() OVER (
      PARTITION BY payload.project_id, payload.display_identity, payload.payload_identity, payload.snapshot_id, payload.article_id
      ORDER BY COALESCE(selected_base.tombstone, FALSE) ASC, selected_base.project_scope_identity ASC NULLS LAST
    ) AS row_number
  FROM payload_rows payload
  LEFT JOIN app.article article
    ON article.id = payload.article_id
  LEFT JOIN app.review_selected_article_import_v4 selected_base
    ON selected_base.project_id = payload.project_id
   AND selected_base.selected_import_snapshot_id = payload.selected_import_snapshot_id
   AND selected_base.article_id = payload.article_id
  LEFT JOIN app.review_import_article_hot_field selected_hot
    ON selected_hot.import_route_id = CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_base.import_route_id
      END
   AND selected_hot.article_id = payload.article_id
   AND selected_hot.source_record_key = CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_base.source_record_key
      END
   AND NOT selected_hot.tombstone
  LEFT JOIN app.article_import_route_source_record selected_source
    ON selected_source.import_route_id = CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_base.import_route_id
      END
   AND selected_source.article_id = payload.article_id
   AND selected_source.source_record_key = CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_base.source_record_key
      END
   AND selected_source.quarantined_at IS NULL
)
SELECT
  project_id,
  display_identity,
  payload_identity,
  snapshot_id,
  article_id,
  article_title,
  article_external_id,
  article_updated_at,
  arxiv_id,
  biorxiv_id,
  medrxiv_id,
  doi,
  pmid,
  journal_title,
  url,
  abstract_text
FROM hydrated_rows
WHERE row_number = 1;

DROP TABLE mart.review_article_serving_payload_v4;

ALTER TABLE mart.review_article_serving_payload_v4_display_repair RENAME TO review_article_serving_payload_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk
ON mart.review_article_serving_payload_v4(project_id, display_identity, payload_identity, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_lookup
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_id);

DROP TABLE IF EXISTS mart.review_article_serving_payload_v4_display_repair;
