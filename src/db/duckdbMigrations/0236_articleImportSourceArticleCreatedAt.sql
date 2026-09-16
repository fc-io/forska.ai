ALTER TABLE app.article_import_route
ADD COLUMN IF NOT EXISTS source_article_created_at TIMESTAMPTZ;

ALTER TABLE app.article_import_route_source_record
ADD COLUMN IF NOT EXISTS source_article_created_at TIMESTAMPTZ;

UPDATE app.article_import_route
SET source_article_created_at = (
  SELECT article.article_created_at
  FROM app.article article
  WHERE article.id = app.article_import_route.article_id
)
WHERE source_article_created_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM app.article article
    WHERE article.id = app.article_import_route.article_id
      AND article.article_created_at IS NOT NULL
  );

UPDATE app.article_import_route_source_record
SET source_article_created_at = (
  SELECT article.article_created_at
  FROM app.article article
  WHERE article.id = app.article_import_route_source_record.article_id
)
WHERE source_article_created_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM app.article article
    WHERE article.id = app.article_import_route_source_record.article_id
      AND article.article_created_at IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_app_article_import_route_source_article_created_at
ON app.article_import_route(import_route_id, source_article_created_at);

CREATE INDEX IF NOT EXISTS idx_app_article_import_route_source_record_source_article_created_at
ON app.article_import_route_source_record(import_route_id, source_article_created_at);
