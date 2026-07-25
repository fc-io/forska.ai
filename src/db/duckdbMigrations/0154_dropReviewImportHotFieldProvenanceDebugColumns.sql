DROP TABLE IF EXISTS app.review_import_article_hot_field_repair;

CREATE TABLE app.review_import_article_hot_field_repair (
  import_route_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  source_record_key VARCHAR NOT NULL,
  source_kind VARCHAR,
  selected_rank_key VARCHAR,
  selected_rank_numeric DOUBLE,
  publication_year INTEGER,
  article_title VARCHAR,
  journal_title VARCHAR,
  external_id VARCHAR,
  duplicate_flag BOOLEAN,
  conflict_flag BOOLEAN,
  filter_bucket_key VARCHAR,
  filter_bucket_value VARCHAR,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(import_route_id, article_id, source_record_key),
  CHECK (length(trim(import_route_id)) > 0),
  CHECK (length(trim(article_id)) > 0),
  CHECK (length(trim(source_record_key)) > 0)
);

INSERT INTO app.review_import_article_hot_field_repair
SELECT
  import_route_id,
  article_id,
  source_record_key,
  source_kind,
  selected_rank_key,
  selected_rank_numeric,
  publication_year,
  article_title,
  journal_title,
  external_id,
  duplicate_flag,
  conflict_flag,
  filter_bucket_key,
  filter_bucket_value,
  tombstone
FROM app.review_import_article_hot_field;

DROP TABLE app.review_import_article_hot_field;

ALTER TABLE app.review_import_article_hot_field_repair RENAME TO review_import_article_hot_field;

DROP TABLE IF EXISTS app.review_import_article_hot_field_repair;
