ALTER TABLE mart.review_article_display_patch_v4
ADD COLUMN IF NOT EXISTS activity_sort_at TIMESTAMPTZ;
