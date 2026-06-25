ALTER TABLE mart.review_selected_import_patch_v4 ADD COLUMN IF NOT EXISTS source_record_key VARCHAR;
ALTER TABLE mart.review_selected_import_patch_v4 ADD COLUMN IF NOT EXISTS article_title VARCHAR;
ALTER TABLE mart.review_selected_import_patch_v4 ADD COLUMN IF NOT EXISTS journal_title VARCHAR;
ALTER TABLE mart.review_selected_import_patch_v4 ADD COLUMN IF NOT EXISTS external_id VARCHAR;
