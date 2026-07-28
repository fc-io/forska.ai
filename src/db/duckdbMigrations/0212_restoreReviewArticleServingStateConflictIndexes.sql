CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_base_v4_pk
ON mart.review_article_serving_base_v4(project_id, review_config_hash, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_base_v4_order
ON mart.review_article_serving_base_v4(project_id, review_config_hash, snapshot_id, sort_key, article_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_list_mode_state_v4_pk
ON mart.review_article_serving_list_mode_state_v4(project_id, review_config_hash, snapshot_id, article_id);
