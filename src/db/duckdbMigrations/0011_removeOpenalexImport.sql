ALTER TABLE app.user_config DROP COLUMN IF EXISTS openalex_mailto;

UPDATE app.data_source
SET import_route = NULL,
    updated_at = current_timestamp
WHERE import_route = '/api/datasources/import/openalex';
