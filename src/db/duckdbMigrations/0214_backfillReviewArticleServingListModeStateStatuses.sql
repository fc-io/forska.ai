UPDATE mart.review_article_serving_list_mode_state_v4 state
SET
  llm_status = source.llm_status,
  human_status = source.human_status,
  llm_has_judgment = COALESCE(source.llm_has_judgment, FALSE)
FROM (
  WITH enabled_prompt_count AS (
    SELECT
      project_prompt.project_id,
      COUNT(*) AS prompt_count
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
    GROUP BY project_prompt.project_id
  ),
  article_judgment_status AS (
    SELECT
      state.project_id,
      state.review_config_hash,
      state.snapshot_id,
      state.article_id,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'llm'
      ) AS llm_enabled_prompt_count,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'llm'
          AND detail.is_answered IS TRUE
      ) AS llm_answered_prompt_count,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'llm'
          AND detail.is_answered IS TRUE
          AND detail.placeholder_kind IS NULL
      ) AS llm_answered_non_placeholder_prompt_count,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'human'
          AND detail.prompt_id <> 'summary'
          AND detail.is_answered IS TRUE
      ) AS human_answered_prompt_count,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'human'
          AND detail.prompt_id = 'summary'
          AND detail.is_answered IS TRUE
      ) AS human_answered_summary_count,
      COUNT(detail.article_id) > 0 AS has_judgment_detail
    FROM mart.review_article_serving_list_mode_state_v4 state
    LEFT JOIN mart.review_article_judgment_detail_serving_v4 detail
      ON detail.project_id = state.project_id
     AND detail.review_config_hash = state.review_config_hash
     AND detail.snapshot_id = state.snapshot_id
     AND detail.article_id = state.article_id
     AND detail.payload_kind IN ('llm', 'human')
    GROUP BY
      state.project_id,
      state.review_config_hash,
      state.snapshot_id,
      state.article_id
  )
  SELECT
    article_status.project_id,
    article_status.review_config_hash,
    article_status.snapshot_id,
    article_status.article_id,
    article_status.has_judgment_detail,
    CASE
      WHEN COALESCE(enabled_prompt_count.prompt_count, 0) = 0 THEN NULL
      WHEN enabled_prompt_count.prompt_count = article_status.llm_answered_prompt_count THEN 'answered'
      ELSE 'unanswered'
    END AS llm_status,
    article_status.llm_answered_non_placeholder_prompt_count > 0 AS llm_has_judgment,
    CASE
      WHEN COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
        AND article_status.human_answered_summary_count > 0 THEN 'answered'
      WHEN COALESCE(project.human_judgment_mode, 'prompt') = 'summary' THEN 'unanswered'
      WHEN COALESCE(enabled_prompt_count.prompt_count, 0) = 0 THEN NULL
      WHEN enabled_prompt_count.prompt_count = article_status.human_answered_prompt_count THEN 'answered'
      ELSE 'unanswered'
    END AS human_status
  FROM article_judgment_status article_status
  LEFT JOIN app.project project
    ON project.id = article_status.project_id
  LEFT JOIN enabled_prompt_count
    ON enabled_prompt_count.project_id = article_status.project_id
) source
WHERE state.project_id = source.project_id
  AND state.review_config_hash = source.review_config_hash
  AND state.snapshot_id = source.snapshot_id
  AND state.article_id = source.article_id
  AND source.has_judgment_detail;
