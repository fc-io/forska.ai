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
     article_status AS (
       SELECT
         serving.project_id,
         serving.review_config_hash,
         serving.snapshot_id,
         serving.article_id,
         CASE
           WHEN COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
             AND BOOL_OR(NULLIF(TRIM(COALESCE(judgment_human_summary.answer, '')), '') IS NOT NULL) THEN 'answered'
           WHEN COALESCE(project.human_judgment_mode, 'prompt') = 'summary' THEN 'unanswered'
           WHEN COALESCE(enabled_prompt_count.prompt_count, 0) = 0 THEN NULL
           WHEN enabled_prompt_count.prompt_count = COUNT(DISTINCT prompt.id) FILTER (
             WHERE judgment_human.id IS NOT NULL
           ) THEN 'answered'
           ELSE 'unanswered'
         END AS human_status
       FROM mart.review_article_serving_base_v4 serving
       INNER JOIN article_range_filter range
         ON (range.chunk_start_article_id IS NULL OR serving.article_id >= range.chunk_start_article_id)
        AND (range.chunk_end_article_id IS NULL OR serving.article_id <= range.chunk_end_article_id)
       INNER JOIN app.project project
         ON project.id = serving.project_id
       LEFT JOIN enabled_prompt_count
         ON enabled_prompt_count.project_id = serving.project_id
       LEFT JOIN app.project_prompt project_prompt
         ON project_prompt.project_id = project.id
        AND project_prompt.enabled
        AND NOT project_prompt.archived
       LEFT JOIN app.prompt prompt
         ON prompt.id = project_prompt.prompt_id
        AND COALESCE(prompt.archived, FALSE) = FALSE
       LEFT JOIN app."judgment_human" judgment_human
         ON judgment_human.project_id IS NOT DISTINCT FROM serving.project_id
        AND judgment_human.article_id = serving.article_id
        AND judgment_human.prompt_id = prompt.id
        AND COALESCE(project.human_judgment_mode, 'prompt') <> 'summary'
       LEFT JOIN app."judgment_human_summary" judgment_human_summary
         ON judgment_human_summary.project_id = serving.project_id
        AND judgment_human_summary.article_id = serving.article_id
        AND COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
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
             WHERE json_extract_string(component_state.value, '$.component') = 'humanStatus'
               AND json_extract_string(component_state.value, '$.projectionIdentity') = 'humanStatus:test'
           )
             AND snapshot.snapshot_status IN ('candidate', 'active')
         )
       GROUP BY serving.project_id, serving.review_config_hash, serving.snapshot_id, serving.article_id, project.human_judgment_mode, enabled_prompt_count.prompt_count
     )
     UPDATE mart.review_article_serving_list_mode_state_v4 state
     SET human_status = article_status.human_status, human_patch_watermark = GREATEST(COALESCE(state.human_patch_watermark, 0), 0), both_patch_watermark = GREATEST(COALESCE(state.both_patch_watermark, 0), 0)
     FROM article_status
     WHERE state.project_id = article_status.project_id
       AND state.review_config_hash IS NOT DISTINCT FROM article_status.review_config_hash
       AND state.snapshot_id = article_status.snapshot_id
       AND state.article_id = article_status.article_id
