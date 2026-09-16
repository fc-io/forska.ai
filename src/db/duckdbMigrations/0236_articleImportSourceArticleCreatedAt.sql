ALTER TABLE app.article_import_route
ADD COLUMN IF NOT EXISTS source_article_created_at TIMESTAMPTZ;

ALTER TABLE app.article_import_route_source_record
ADD COLUMN IF NOT EXISTS source_article_created_at TIMESTAMPTZ;

UPDATE app.article_import_route
SET source_article_created_at = TRY_CAST(NULLIF(COALESCE(
  json_extract_string(raw_payload, '$.sourceArticleCreatedAt'),
  json_extract_string(raw_payload, '$.source_article_created_at'),
  json_extract_string(raw_payload, '$.articleCreatedAt'),
  json_extract_string(raw_payload, '$.article_created_at'),
  json_extract_string(raw_payload, '$.createdAt'),
  json_extract_string(raw_payload, '$.created_at'),
  json_extract_string(raw_payload, '$.publishedAt'),
  json_extract_string(raw_payload, '$.published_at'),
  json_extract_string(raw_payload, '$.publicationDate'),
  json_extract_string(raw_payload, '$.publication_date'),
  json_extract_string(raw_payload, '$.date'),
  json_extract_string(raw_payload, '$.covidence.citation.date'),
  json_extract_string(raw_payload, '$.covidence.citation.publication_date')
), '') AS TIMESTAMPTZ)
WHERE source_article_created_at IS NULL
  AND raw_payload IS NOT NULL;

UPDATE app.article_import_route_source_record
SET source_article_created_at = TRY_CAST(NULLIF(COALESCE(
  json_extract_string(raw_payload, '$.sourceArticleCreatedAt'),
  json_extract_string(raw_payload, '$.source_article_created_at'),
  json_extract_string(raw_payload, '$.articleCreatedAt'),
  json_extract_string(raw_payload, '$.article_created_at'),
  json_extract_string(raw_payload, '$.createdAt'),
  json_extract_string(raw_payload, '$.created_at'),
  json_extract_string(raw_payload, '$.publishedAt'),
  json_extract_string(raw_payload, '$.published_at'),
  json_extract_string(raw_payload, '$.publicationDate'),
  json_extract_string(raw_payload, '$.publication_date'),
  json_extract_string(raw_payload, '$.date'),
  json_extract_string(raw_payload, '$.covidence.citation.date'),
  json_extract_string(raw_payload, '$.covidence.citation.publication_date')
), '') AS TIMESTAMPTZ)
WHERE source_article_created_at IS NULL
  AND raw_payload IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_article_import_route_source_article_created_at
ON app.article_import_route(import_route_id, source_article_created_at);

CREATE INDEX IF NOT EXISTS idx_app_article_import_route_source_record_source_article_created_at
ON app.article_import_route_source_record(import_route_id, source_article_created_at);
