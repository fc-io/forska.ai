ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS article_created_at TIMESTAMPTZ;
ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS source_metadata JSON;

ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS article_created_at TIMESTAMPTZ;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS source_metadata JSON;
