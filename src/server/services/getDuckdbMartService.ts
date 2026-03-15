import {getAppDatabaseService} from './appDatabaseService.ts'

const rebuildProjectScopeArticleSql = `
BEGIN TRANSACTION;
DELETE FROM mart.project_scope_article;
INSERT INTO mart.project_scope_article (
  project_id,
  article_id,
  in_curated_scope,
  in_route_scope,
  matched_import_route_ids,
  article_title,
  article_created_at,
  article_updated_at,
  article_import_route,
  article_publication_status,
  source_updated_at
)
WITH route_scope AS (
  SELECT
    pir.project_id,
    air.article_id,
    air.import_route_id,
    TRUE AS in_route_scope,
    FALSE AS in_curated_scope
  FROM app.project_import_route pir
  INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
),
curated_scope AS (
  SELECT
    pa.project_id,
    pa.article_id,
    NULL AS import_route_id,
    FALSE AS in_route_scope,
    TRUE AS in_curated_scope
  FROM app.project_article pa
),
combined_scope AS (
  SELECT * FROM route_scope
  UNION ALL
  SELECT * FROM curated_scope
),
aggregated_scope AS (
  SELECT
    project_id,
    article_id,
    COALESCE(BOOL_OR(in_curated_scope), FALSE) AS in_curated_scope,
    COALESCE(BOOL_OR(in_route_scope), FALSE) AS in_route_scope,
    LIST(DISTINCT import_route_id) FILTER (WHERE import_route_id IS NOT NULL) AS matched_import_route_ids
  FROM combined_scope
  GROUP BY project_id, article_id
)
SELECT
  aggregated_scope.project_id,
  aggregated_scope.article_id,
  aggregated_scope.in_curated_scope,
  aggregated_scope.in_route_scope,
  aggregated_scope.matched_import_route_ids,
  article.article_title,
  article.article_created_at,
  article.article_updated_at,
  article.import_route,
  article.publication_status,
  article.updated_at
FROM aggregated_scope
INNER JOIN app.article article ON article.id = aggregated_scope.article_id;
COMMIT;
`

const rebuildJudgmentFactSql = `
BEGIN TRANSACTION;
DELETE FROM mart.judgment_fact;
INSERT INTO mart.judgment_fact (
  judgment_id,
  article_id,
  prompt_id,
  model_id,
  project_id,
  snapshot_project_id,
  snapshot_project_model_name,
  use_title,
  use_abstract,
  use_fulltext,
  use_fulltext_no_images,
  chunking_strategy,
  is_answered,
  answered_original,
  answered_original_as_array,
  normalized_answers,
  confidence_original,
  explanation,
  quotes,
  article_title,
  article_created_at,
  article_updated_at,
  article_import_route,
  article_publication_status,
  created_at,
  updated_at
)
SELECT
  judgment.id,
  judgment.article_id,
  judgment.prompt_id,
  judgment.model_id,
  judgment.project_id,
  judgment.snapshot_project_id,
  judgment.snapshot_project_model_name,
  judgment.use_title,
  judgment.use_abstract,
  judgment.use_fulltext,
  judgment.use_fulltext_no_images,
  judgment.chunking_strategy,
  judgment.is_answered,
  NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') AS answered_original,
  judgment.answered_original_as_array,
  CASE
    WHEN judgment.answered_original_as_array IS NOT NULL AND ARRAY_LENGTH(judgment.answered_original_as_array) > 0
      THEN judgment.answered_original_as_array
    WHEN NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') IS NOT NULL
      THEN [TRIM(COALESCE(judgment.answered_original, ''))]
    ELSE NULL
  END AS normalized_answers,
  judgment.confidence_original,
  judgment.explanation,
  judgment.quotes,
  article.article_title,
  article.article_created_at,
  article.article_updated_at,
  article.import_route,
  article.publication_status,
  judgment.created_at,
  judgment.updated_at
FROM app.judgment judgment
INNER JOIN app.article article ON article.id = judgment.article_id
WHERE judgment.deleted_at IS NULL;
COMMIT;
`

const rebuildPromptAnswerFactSql = `
BEGIN TRANSACTION;
DELETE FROM mart.prompt_answer_fact;
INSERT INTO mart.prompt_answer_fact (
  project_id,
  article_id,
  prompt_id,
  judgment_id,
  model_id,
  answer_value,
  answered_original,
  article_title,
  article_created_at,
  article_updated_at,
  judgment_created_at
)
WITH eligible_project_judgment AS (
  SELECT
    scope_article.project_id,
    judgment_fact.article_id,
    judgment_fact.prompt_id,
    judgment_fact.judgment_id,
    judgment_fact.model_id,
    judgment_fact.answered_original,
    judgment_fact.normalized_answers,
    judgment_fact.article_title,
    judgment_fact.article_created_at,
    judgment_fact.article_updated_at,
    judgment_fact.created_at AS judgment_created_at
  FROM mart.project_scope_article scope_article
  INNER JOIN app.project project ON project.id = scope_article.project_id
  INNER JOIN app.project_prompt project_prompt
    ON project_prompt.project_id = scope_article.project_id
   AND project_prompt.enabled = TRUE
  INNER JOIN mart.judgment_fact judgment_fact
    ON judgment_fact.article_id = scope_article.article_id
   AND judgment_fact.prompt_id = project_prompt.prompt_id
   AND judgment_fact.model_id = project.model_id
   AND judgment_fact.use_title = project.use_title
   AND judgment_fact.use_abstract = project.use_abstract
   AND judgment_fact.use_fulltext = project.use_fulltext
   AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
)
SELECT
  eligible_project_judgment.project_id,
  eligible_project_judgment.article_id,
  eligible_project_judgment.prompt_id,
  eligible_project_judgment.judgment_id,
  eligible_project_judgment.model_id,
  TRIM(answer.answer_value) AS answer_value,
  eligible_project_judgment.answered_original,
  eligible_project_judgment.article_title,
  eligible_project_judgment.article_created_at,
  eligible_project_judgment.article_updated_at,
  eligible_project_judgment.judgment_created_at
FROM eligible_project_judgment,
  UNNEST(eligible_project_judgment.normalized_answers) AS answer(answer_value)
WHERE eligible_project_judgment.normalized_answers IS NOT NULL
  AND ARRAY_LENGTH(eligible_project_judgment.normalized_answers) > 0
  AND NULLIF(TRIM(answer.answer_value), '') IS NOT NULL;
COMMIT;
`

const rebuildReviewArticleRollupSql = `
BEGIN TRANSACTION;
DELETE FROM mart.review_article_rollup;
INSERT INTO mart.review_article_rollup (
  project_id,
  article_id,
  article_title,
  article_created_at,
  article_updated_at,
  article_import_route,
  article_publication_status,
  matched_import_route_ids,
  enabled_prompt_count,
  llm_judged_prompt_count,
  human_answered_prompt_count,
  llm_judged_prompt_ids,
  human_answered_prompt_ids,
  has_all_llm_judgments,
  has_all_human_answers,
  in_curated_scope,
  in_route_scope,
  review_opened,
  review_sections_completed,
  latest_llm_created_at,
  latest_human_updated_at,
  latest_review_updated_at,
  rollup_updated_at
)
WITH enabled_project_prompt AS (
  SELECT project_id, prompt_id
  FROM app.project_prompt
  WHERE enabled = TRUE
),
enabled_project_prompt_count AS (
  SELECT project_id, COUNT(*) AS enabled_prompt_count
  FROM enabled_project_prompt
  GROUP BY project_id
),
llm_project_prompt AS (
  SELECT
    scope_article.project_id,
    judgment_fact.article_id,
    judgment_fact.prompt_id,
    MAX(judgment_fact.created_at) AS latest_llm_created_at
  FROM mart.project_scope_article scope_article
  INNER JOIN app.project project ON project.id = scope_article.project_id
  INNER JOIN enabled_project_prompt enabled_prompt
    ON enabled_prompt.project_id = scope_article.project_id
  INNER JOIN mart.judgment_fact judgment_fact
    ON judgment_fact.article_id = scope_article.article_id
   AND judgment_fact.prompt_id = enabled_prompt.prompt_id
   AND judgment_fact.model_id = project.model_id
   AND judgment_fact.use_title = project.use_title
   AND judgment_fact.use_abstract = project.use_abstract
   AND judgment_fact.use_fulltext = project.use_fulltext
   AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
  GROUP BY scope_article.project_id, judgment_fact.article_id, judgment_fact.prompt_id
),
llm_project_rollup AS (
  SELECT
    project_id,
    article_id,
    COUNT(DISTINCT prompt_id) AS llm_judged_prompt_count,
    LIST(DISTINCT prompt_id) AS llm_judged_prompt_ids,
    MAX(latest_llm_created_at) AS latest_llm_created_at
  FROM llm_project_prompt
  GROUP BY project_id, article_id
),
human_project_prompt AS (
  SELECT
    judgment_human.project_id,
    judgment_human.article_id,
    judgment_human.prompt_id,
    MAX(judgment_human.updated_at) AS latest_human_updated_at
  FROM app.judgment_human judgment_human
  INNER JOIN enabled_project_prompt enabled_prompt
    ON enabled_prompt.project_id = judgment_human.project_id
   AND enabled_prompt.prompt_id = judgment_human.prompt_id
  WHERE judgment_human.is_answered = TRUE
    AND NULLIF(TRIM(COALESCE(judgment_human.answer, '')), '') IS NOT NULL
  GROUP BY judgment_human.project_id, judgment_human.article_id, judgment_human.prompt_id
),
human_project_rollup AS (
  SELECT
    project_id,
    article_id,
    COUNT(DISTINCT prompt_id) AS human_answered_prompt_count,
    LIST(DISTINCT prompt_id) AS human_answered_prompt_ids,
    MAX(latest_human_updated_at) AS latest_human_updated_at
  FROM human_project_prompt
  GROUP BY project_id, article_id
),
review_state AS (
  SELECT
    review.project_id,
    review.article_id,
    MAX(review.updated_at) AS latest_review_updated_at,
    COALESCE(BOOL_OR(review.opened), FALSE) AS review_opened,
    MAX(
      CAST(review.reviewed_title AS INTEGER)
      + CAST(review.reviewed_abstract AS INTEGER)
      + CAST(review.reviewed_intro AS INTEGER)
      + CAST(review.reviewed_method AS INTEGER)
      + CAST(review.reviewed_results AS INTEGER)
      + CAST(review.reviewed_discussion AS INTEGER)
      + CAST(review.reviewed_conclusion AS INTEGER)
      + CAST(review.reviewed_appendix AS INTEGER)
      + CAST(review.reviewed_other AS INTEGER)
    ) AS review_sections_completed
  FROM app.review review
  GROUP BY review.project_id, review.article_id
)
SELECT
  scope_article.project_id,
  scope_article.article_id,
  scope_article.article_title,
  scope_article.article_created_at,
  scope_article.article_updated_at,
  scope_article.article_import_route,
  scope_article.article_publication_status,
  scope_article.matched_import_route_ids,
  COALESCE(prompt_count.enabled_prompt_count, 0) AS enabled_prompt_count,
  COALESCE(llm_rollup.llm_judged_prompt_count, 0) AS llm_judged_prompt_count,
  COALESCE(human_rollup.human_answered_prompt_count, 0) AS human_answered_prompt_count,
  llm_rollup.llm_judged_prompt_ids,
  human_rollup.human_answered_prompt_ids,
  COALESCE(prompt_count.enabled_prompt_count, 0) > 0
    AND COALESCE(llm_rollup.llm_judged_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0) AS has_all_llm_judgments,
  COALESCE(prompt_count.enabled_prompt_count, 0) > 0
    AND COALESCE(human_rollup.human_answered_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0) AS has_all_human_answers,
  scope_article.in_curated_scope,
  scope_article.in_route_scope,
  COALESCE(review_state.review_opened, FALSE) AS review_opened,
  COALESCE(review_state.review_sections_completed, 0) AS review_sections_completed,
  llm_rollup.latest_llm_created_at,
  human_rollup.latest_human_updated_at,
  review_state.latest_review_updated_at,
  current_timestamp AS rollup_updated_at
FROM mart.project_scope_article scope_article
LEFT JOIN enabled_project_prompt_count prompt_count ON prompt_count.project_id = scope_article.project_id
LEFT JOIN llm_project_rollup llm_rollup
  ON llm_rollup.project_id = scope_article.project_id
 AND llm_rollup.article_id = scope_article.article_id
LEFT JOIN human_project_rollup human_rollup
  ON human_rollup.project_id = scope_article.project_id
 AND human_rollup.article_id = scope_article.article_id
LEFT JOIN review_state
  ON review_state.project_id = scope_article.project_id
 AND review_state.article_id = scope_article.article_id;
COMMIT;
`

const runRebuildSql = async (sql: string) => {
  await getAppDatabaseService().run(sql)
}

const rebuildAllDuckdbMarts = async (): Promise<void> => {
  await runRebuildSql(rebuildProjectScopeArticleSql)
  await runRebuildSql(rebuildJudgmentFactSql)
  await runRebuildSql(rebuildPromptAnswerFactSql)
  await runRebuildSql(rebuildReviewArticleRollupSql)
}

const duckdbMartService = {
  rebuildAll: rebuildAllDuckdbMarts,
  rebuildJudgmentFact: async () => {
    await runRebuildSql(rebuildJudgmentFactSql)
  },
  rebuildProjectScopeArticle: async () => {
    await runRebuildSql(rebuildProjectScopeArticleSql)
  },
  rebuildPromptAnswerFact: async () => {
    await runRebuildSql(rebuildPromptAnswerFactSql)
  },
  rebuildReviewArticleRollup: async () => {
    await runRebuildSql(rebuildReviewArticleRollupSql)
  },
}

export const getDuckdbMartService = () => {
  return duckdbMartService
}
