ALTER TABLE app.review_projection_identity_manifest
ADD COLUMN IF NOT EXISTS input_watermarks_json JSON;

UPDATE app.review_projection_identity_manifest
SET input_watermarks_json = '{}'
WHERE input_watermarks_json IS NULL;
