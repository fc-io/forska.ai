UPDATE mart.review_article_serving_detail detail
SET
  judgment_project_id = COALESCE(detail.judgment_project_id, judgment.project_id),
  judgment_updated_at = COALESCE(detail.judgment_updated_at, judgment.updated_at),
  snapshot_project_id = COALESCE(detail.snapshot_project_id, judgment.snapshot_project_id),
  snapshot_project_model_name = COALESCE(detail.snapshot_project_model_name, judgment.snapshot_project_model_name)
FROM app.judgment judgment
WHERE detail.judgment_id = judgment.id
  AND (
    detail.judgment_project_id IS NULL
    OR detail.judgment_updated_at IS NULL
    OR detail.snapshot_project_id IS NULL
    OR detail.snapshot_project_model_name IS NULL
  );

UPDATE mart.judgment_fact
SET
  project_id = NULL,
  snapshot_project_id = NULL,
  snapshot_project_model_name = NULL
WHERE project_id IS NOT NULL
   OR snapshot_project_id IS NOT NULL
   OR snapshot_project_model_name IS NOT NULL;
