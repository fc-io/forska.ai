INSERT INTO mart.review_article_judgment_detail_serving_v4 (
  project_id,
  review_config_hash,
  snapshot_id,
  payload_kind,
  article_id,
  prompt_id,
  prompt_order,
  judgment_id,
  is_answered,
  answered_original,
  answered_original_as_array,
  judgment_created_at,
  human_comment,
  placeholder_kind,
  detail_updated_at
)
WITH active_snapshot AS (
  SELECT
    manifest.project_id,
    manifest.review_config_hash,
    manifest.snapshot_id,
    project.model_id,
    project.use_title,
    project.use_abstract,
    project.use_fulltext,
    project.use_fulltext_no_images
  FROM app.review_serving_snapshot_manifest manifest
  INNER JOIN app.project project
    ON project.id = manifest.project_id
  WHERE manifest.snapshot_status = 'active'
),
active_article AS (
  SELECT DISTINCT
    snapshot.project_id,
    snapshot.review_config_hash,
    snapshot.snapshot_id,
    snapshot.model_id,
    snapshot.use_title,
    snapshot.use_abstract,
    snapshot.use_fulltext,
    snapshot.use_fulltext_no_images,
    scope.article_id
  FROM active_snapshot snapshot
  INNER JOIN mart.project_scope_article scope
    ON scope.project_id = snapshot.project_id
   AND (scope.in_curated_scope OR scope.in_route_scope)
),
enabled_prompt AS (
  SELECT
    project_prompt.project_id,
    prompt.id AS prompt_id,
    project_prompt.prompt_order
  FROM app.project_prompt project_prompt
  INNER JOIN app.prompt prompt
    ON prompt.id = project_prompt.prompt_id
  WHERE project_prompt.enabled
    AND NOT project_prompt.archived
    AND COALESCE(prompt.archived, FALSE) = FALSE
),
latest_judgment AS (
  SELECT
    active.project_id,
    active.review_config_hash,
    active.snapshot_id,
    judgment.article_id,
    judgment.prompt_id,
    prompt.prompt_order,
    judgment.id AS judgment_id,
    judgment.is_answered,
    judgment.answered_original,
    judgment.answered_original_as_array,
    judgment.created_at AS judgment_created_at,
    judgment.updated_at AS judgment_updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY active.project_id, active.review_config_hash, active.snapshot_id, judgment.article_id, judgment.prompt_id
      ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC
    ) AS judgment_rank
  FROM active_article active
  INNER JOIN app."judgment" judgment
    ON judgment.article_id = active.article_id
   AND judgment.model_id = active.model_id
   AND judgment.use_title = active.use_title
   AND judgment.use_abstract = active.use_abstract
   AND judgment.use_fulltext = active.use_fulltext
   AND judgment.use_fulltext_no_images = active.use_fulltext_no_images
   AND judgment.deleted_at IS NULL
  INNER JOIN enabled_prompt prompt
    ON prompt.project_id = active.project_id
   AND prompt.prompt_id = judgment.prompt_id
)
SELECT
  latest.project_id,
  latest.review_config_hash,
  latest.snapshot_id,
  'llm' AS payload_kind,
  latest.article_id,
  latest.prompt_id,
  latest.prompt_order,
  latest.judgment_id,
  latest.is_answered,
  latest.answered_original,
  latest.answered_original_as_array,
  latest.judgment_created_at,
  NULL AS human_comment,
  NULL AS placeholder_kind,
  COALESCE(latest.judgment_updated_at, current_timestamp) AS detail_updated_at
FROM latest_judgment latest
WHERE latest.judgment_rank = 1
  AND NOT EXISTS (
    SELECT 1
    FROM mart.review_article_judgment_detail_serving_v4 existing
    WHERE existing.project_id = latest.project_id
      AND existing.review_config_hash = latest.review_config_hash
      AND existing.snapshot_id = latest.snapshot_id
      AND existing.payload_kind = 'llm'
      AND existing.article_id = latest.article_id
      AND existing.prompt_id = latest.prompt_id
  );

INSERT INTO mart.review_article_judgment_detail_serving_v4 (
  project_id,
  review_config_hash,
  snapshot_id,
  payload_kind,
  article_id,
  prompt_id,
  prompt_order,
  judgment_id,
  is_answered,
  answered_original,
  answered_original_as_array,
  judgment_created_at,
  human_comment,
  placeholder_kind,
  detail_updated_at
)
WITH active_snapshot AS (
  SELECT
    manifest.project_id,
    manifest.review_config_hash,
    manifest.snapshot_id,
    COALESCE(project.human_judgment_mode, 'prompt') AS human_judgment_mode
  FROM app.review_serving_snapshot_manifest manifest
  INNER JOIN app.project project
    ON project.id = manifest.project_id
  WHERE manifest.snapshot_status = 'active'
),
active_article AS (
  SELECT DISTINCT
    snapshot.project_id,
    snapshot.review_config_hash,
    snapshot.snapshot_id,
    snapshot.human_judgment_mode,
    scope.article_id
  FROM active_snapshot snapshot
  INNER JOIN mart.project_scope_article scope
    ON scope.project_id = snapshot.project_id
   AND (scope.in_curated_scope OR scope.in_route_scope)
),
enabled_prompt AS (
  SELECT
    project_prompt.project_id,
    prompt.id AS prompt_id,
    project_prompt.prompt_order
  FROM app.project_prompt project_prompt
  INNER JOIN app.prompt prompt
    ON prompt.id = project_prompt.prompt_id
  WHERE project_prompt.enabled
    AND NOT project_prompt.archived
    AND COALESCE(prompt.archived, FALSE) = FALSE
),
payload AS (
  SELECT
    active.project_id,
    active.review_config_hash,
    active.snapshot_id,
    active.article_id,
    prompt.prompt_id,
    prompt.prompt_order,
    judgment_human.id AS judgment_id,
    judgment_human.is_answered,
    judgment_human.answer AS answered_original,
    NULL::VARCHAR[] AS answered_original_as_array,
    judgment_human.created_at AS judgment_created_at,
    judgment_human.updated_at AS judgment_updated_at,
    judgment_human.comment AS human_comment
  FROM active_article active
  INNER JOIN app."judgment_human" judgment_human
    ON judgment_human.project_id IS NOT DISTINCT FROM active.project_id
   AND judgment_human.article_id = active.article_id
   AND active.human_judgment_mode = 'prompt'
  INNER JOIN enabled_prompt prompt
    ON prompt.project_id = active.project_id
   AND prompt.prompt_id = judgment_human.prompt_id
  UNION ALL
  SELECT
    active.project_id,
    active.review_config_hash,
    active.snapshot_id,
    active.article_id,
    'summary' AS prompt_id,
    -1 AS prompt_order,
    judgment_human_summary.id AS judgment_id,
    judgment_human_summary.answer IS NOT NULL OR judgment_human_summary.origin = 'covidence_import' AS is_answered,
    judgment_human_summary.answer AS answered_original,
    NULL::VARCHAR[] AS answered_original_as_array,
    judgment_human_summary.created_at AS judgment_created_at,
    judgment_human_summary.updated_at AS judgment_updated_at,
    NULL AS human_comment
  FROM active_article active
  INNER JOIN app."judgment_human_summary" judgment_human_summary
    ON judgment_human_summary.project_id = active.project_id
   AND judgment_human_summary.article_id = active.article_id
   AND active.human_judgment_mode = 'summary'
)
SELECT
  payload.project_id,
  payload.review_config_hash,
  payload.snapshot_id,
  'human' AS payload_kind,
  payload.article_id,
  payload.prompt_id,
  payload.prompt_order,
  payload.judgment_id,
  payload.is_answered,
  payload.answered_original,
  payload.answered_original_as_array,
  payload.judgment_created_at,
  payload.human_comment,
  NULL AS placeholder_kind,
  COALESCE(payload.judgment_updated_at, current_timestamp) AS detail_updated_at
FROM payload
WHERE NOT EXISTS (
  SELECT 1
  FROM mart.review_article_judgment_detail_serving_v4 existing
  WHERE existing.project_id = payload.project_id
    AND existing.review_config_hash = payload.review_config_hash
    AND existing.snapshot_id = payload.snapshot_id
    AND existing.payload_kind = 'human'
    AND existing.article_id = payload.article_id
    AND existing.prompt_id = payload.prompt_id
);
