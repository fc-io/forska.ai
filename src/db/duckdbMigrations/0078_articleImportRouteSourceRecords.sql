ALTER TABLE app.article_import_route
ADD COLUMN external_article_id VARCHAR;

ALTER TABLE app.article_import_route
ADD COLUMN source_kind VARCHAR;

ALTER TABLE app.article_import_route
ADD COLUMN import_metadata JSON;

ALTER TABLE app.article_import_route
ADD COLUMN match_metadata JSON;

ALTER TABLE app.article_import_route
ADD COLUMN import_run_id VARCHAR;

ALTER TABLE app.article_import_route
ADD COLUMN source_record_key VARCHAR;

ALTER TABLE app.article_import_route
ADD COLUMN source_record_hash VARCHAR;

ALTER TABLE app.article_import_route
ADD COLUMN raw_payload JSON;

CREATE TABLE app.article_import_route_source_record (
  id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL REFERENCES app.article(id),
  import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id),
  external_article_id VARCHAR,
  source_kind VARCHAR,
  import_metadata JSON,
  match_metadata JSON,
  import_run_id VARCHAR,
  source_record_key VARCHAR NOT NULL,
  source_record_hash VARCHAR NOT NULL,
  raw_payload JSON,
  quarantined_at TIMESTAMPTZ,
  quarantine_reason VARCHAR,
  quarantine_metadata JSON,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  UNIQUE(import_route_id, source_record_key)
);

CREATE INDEX IF NOT EXISTS idx_app_article_import_route_source_record_article
ON app.article_import_route_source_record(article_id, import_route_id);
