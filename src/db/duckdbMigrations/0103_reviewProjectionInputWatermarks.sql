ALTER TABLE app.review_projection_identity_manifest
ADD COLUMN IF NOT EXISTS input_watermarks_json JSON NOT NULL DEFAULT '{}';
