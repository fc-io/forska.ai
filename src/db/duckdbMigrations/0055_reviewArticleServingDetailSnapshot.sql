ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS judgment_project_id VARCHAR;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS judgment_updated_at TIMESTAMPTZ;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS use_title BOOLEAN;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS use_abstract BOOLEAN;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS use_fulltext BOOLEAN;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS use_fulltext_no_images BOOLEAN;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS chunking_strategy VARCHAR;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS is_answered BOOLEAN;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS confidence_original INTEGER;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS explanation VARCHAR;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS quotes JSON;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS snapshot_project_id VARCHAR;
ALTER TABLE mart.review_article_serving_detail ADD COLUMN IF NOT EXISTS snapshot_project_model_name VARCHAR;

UPDATE mart.review_article_serving_detail detail
SET
  judgment_project_id = fact.project_id,
  judgment_updated_at = fact.updated_at,
  use_title = fact.use_title,
  use_abstract = fact.use_abstract,
  use_fulltext = fact.use_fulltext,
  use_fulltext_no_images = fact.use_fulltext_no_images,
  chunking_strategy = fact.chunking_strategy,
  is_answered = fact.is_answered,
  confidence_original = fact.confidence_original,
  explanation = fact.explanation,
  quotes = fact.quotes,
  snapshot_project_id = fact.snapshot_project_id,
  snapshot_project_model_name = fact.snapshot_project_model_name
FROM mart.judgment_fact fact
WHERE detail.judgment_id = fact.judgment_id
  AND detail.judgment_project_id IS NULL;
