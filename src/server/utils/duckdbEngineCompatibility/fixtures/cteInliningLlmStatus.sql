WITH article_range_filter(chunk_start_article_id, chunk_end_article_id) AS (
        SELECT * FROM (VALUES ('article-1', 'article-1'))
      ),
     enabled_prompt_count AS (
       SELECT
         project_prompt.project_id,
         COUNT(DISTINCT prompt.id) AS prompt_count
       FROM app.project_prompt project_prompt
       INNER JOIN app.prompt prompt
         ON prompt.id = project_prompt.prompt_id
       WHERE project_prompt.enabled
         AND NOT project_prompt.archived
         AND COALESCE(prompt.archived, FALSE) = FALSE
       GROUP BY project_prompt.project_id
     ),
     target_serving AS (
       SELECT
         serving.project_id,
         serving.review_config_hash,
         serving.snapshot_id,
         serving.article_id
       FROM mart.review_article_serving_base_v4 serving
       INNER JOIN article_range_filter range
         ON (range.chunk_start_article_id IS NULL OR serving.article_id >= range.chunk_start_article_id)
        AND (range.chunk_end_article_id IS NULL OR serving.article_id <= range.chunk_end_article_id)
       WHERE serving.project_id = 'project-1'
         AND serving.base_generation = 0
         AND EXISTS (
           SELECT 1
           FROM app.review_serving_snapshot_manifest snapshot
           WHERE snapshot.project_id = serving.project_id
             AND snapshot.snapshot_id = serving.snapshot_id
             AND snapshot.review_config_hash IS NOT DISTINCT FROM serving.review_config_hash
             AND EXISTS (
             SELECT 1
             FROM (
               SELECT required_state.value
               FROM json_each(json_extract(snapshot.component_state_json, '$.required')) required_state
               UNION ALL
               SELECT optional_state.value
               FROM json_each(json_extract(snapshot.component_state_json, '$.optional')) optional_state
             ) component_state
             WHERE json_extract_string(component_state.value, '$.component') = 'llmStatus'
               AND json_extract_string(component_state.value, '$.projectionIdentity') = 'llmStatus:test'
           )
             AND snapshot.snapshot_status IN ('candidate', 'active')
         )
     ),
     latest_judgment AS (
       SELECT
         judgment.article_id,
         judgment.prompt_id,
         judgment.is_answered,
         ROW_NUMBER() OVER (
           PARTITION BY judgment.article_id, judgment.prompt_id, judgment.model_id, judgment.use_title, judgment.use_abstract, judgment.use_fulltext, judgment.use_fulltext_no_images
           ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC
         ) AS judgment_rank
       FROM target_serving serving
       INNER JOIN app.project project
         ON project.id = serving.project_id
       INNER JOIN app."judgment" judgment
         ON judgment.article_id = serving.article_id
        AND project.model_id = judgment.model_id
        AND project.use_title = judgment.use_title
        AND project.use_abstract = judgment.use_abstract
        AND project.use_fulltext = judgment.use_fulltext
        AND project.use_fulltext_no_images = judgment.use_fulltext_no_images
       WHERE judgment.deleted_at IS NULL
     ),
     article_status AS (
       SELECT
         serving.project_id,
         serving.review_config_hash,
         serving.snapshot_id,
         serving.article_id,
         CASE
           WHEN COALESCE(enabled_prompt_count.prompt_count, 0) = 0 THEN NULL
           WHEN enabled_prompt_count.prompt_count = COUNT(DISTINCT prompt.id) FILTER (
             WHERE latest_judgment.is_answered IS TRUE
           ) THEN 'answered'
           ELSE 'unanswered'
         END AS llm_status,
         COALESCE(BOOL_OR(latest_judgment.is_answered IS TRUE), FALSE) AS llm_has_judgment
       FROM target_serving serving
       INNER JOIN app.project project
         ON project.id = serving.project_id
       INNER JOIN app.project_prompt project_prompt
         ON project_prompt.project_id = project.id
        AND project_prompt.enabled
        AND NOT project_prompt.archived
       INNER JOIN app.prompt prompt
         ON prompt.id = project_prompt.prompt_id
        AND COALESCE(prompt.archived, FALSE) = FALSE
       LEFT JOIN enabled_prompt_count
         ON enabled_prompt_count.project_id = serving.project_id
       LEFT JOIN latest_judgment
         ON latest_judgment.article_id = serving.article_id
        AND latest_judgment.prompt_id = prompt.id
        AND latest_judgment.judgment_rank = 1
       GROUP BY serving.project_id, serving.review_config_hash, serving.snapshot_id, serving.article_id, enabled_prompt_count.prompt_count
     )
     UPDATE mart.review_article_serving_list_mode_state_v4 state
     SET llm_status = article_status.llm_status, llm_has_judgment = article_status.llm_has_judgment, llm_patch_watermark = GREATEST(COALESCE(state.llm_patch_watermark, 0), 0), both_patch_watermark = GREATEST(COALESCE(state.both_patch_watermark, 0), 0)
     FROM article_status
     WHERE state.project_id = article_status.project_id
       AND state.review_config_hash = article_status.review_config_hash
       AND state.snapshot_id = article_status.snapshot_id
       AND state.article_id = article_status.article_id
