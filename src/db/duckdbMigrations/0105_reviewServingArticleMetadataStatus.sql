ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS article_updated_at TIMESTAMPTZ;
ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS arxiv_id VARCHAR;
ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS biorxiv_id VARCHAR;
ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS medrxiv_id VARCHAR;
ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS doi VARCHAR;
ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS pmid VARCHAR;
ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS full_text_fetched_at TIMESTAMPTZ;
ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS full_text_conversion_status VARCHAR;

ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS article_updated_at TIMESTAMPTZ;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS arxiv_id VARCHAR;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS biorxiv_id VARCHAR;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS medrxiv_id VARCHAR;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS doi VARCHAR;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS pmid VARCHAR;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS full_text_pdf VARCHAR;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS full_text_fetched_at TIMESTAMPTZ;
ALTER TABLE mart.review_article_display_patch_v4 ADD COLUMN IF NOT EXISTS full_text_conversion_status VARCHAR;
