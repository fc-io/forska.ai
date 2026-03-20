ALTER TABLE app.article
ADD COLUMN source_metadata JSON;

UPDATE app.article
SET doi = json_extract_string(original_data, '$.doi')
WHERE doi IS NULL
  AND json_extract_string(original_data, '$.doi') IS NOT NULL;
