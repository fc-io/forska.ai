import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'

type ProjectMartLargeRebuildBatchCursor = {articleCreatedAt: Date | string | null; articleId: string}

type ProjectMartLargeRebuildScopeBatchRow = {
  articleCreatedAt: Date | string | null
  articleId: string
  articleUpdatedAt: Date | string | null
  inCuratedScope: boolean
  inRouteScope: boolean
}

type ProjectMartLargeRebuildExecutorDependencies = {
  database: {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
}

type GetProjectScopeBatchParams = {
  batchSize?: number
  cursor?: ProjectMartLargeRebuildBatchCursor | null
  projectId: string
}

const defaultProjectMartLargeRebuildBatchSize = 1_000
const batchEpochSql = "TIMESTAMPTZ '1970-01-01T00:00:00.000Z'"

const getProjectMartLargeRebuildExecutorDatabase = (): ProjectMartLargeRebuildExecutorDependencies['database'] => {
  const database = getAppDatabaseService()

  return {queryJson: database.queryJsonBackground, run: database.runBackground}
}

const defaultProjectMartLargeRebuildExecutorDependencies: ProjectMartLargeRebuildExecutorDependencies = {
  database: getProjectMartLargeRebuildExecutorDatabase(),
}

const getBatchOrderSql = ({
  articleCreatedAtColumn,
  articleIdColumn,
}: {
  articleCreatedAtColumn: string
  articleIdColumn: string
}) => {
  return `COALESCE(${articleCreatedAtColumn}, ${batchEpochSql}) ASC, ${articleIdColumn} ASC`
}

const getBatchCursorWhereSql = ({
  articleCreatedAtColumn,
  articleIdColumn,
  cursor,
}: {
  articleCreatedAtColumn: string
  articleIdColumn: string
  cursor: ProjectMartLargeRebuildBatchCursor | null
}) => {
  if (cursor === null) {
    return ''
  }

  return `
    AND (
      COALESCE(${articleCreatedAtColumn}, ${batchEpochSql}) > COALESCE(${getSqlLiteral(cursor.articleCreatedAt)}, ${batchEpochSql})
      OR (
        COALESCE(${articleCreatedAtColumn}, ${batchEpochSql}) = COALESCE(${getSqlLiteral(cursor.articleCreatedAt)}, ${batchEpochSql})
        AND ${articleIdColumn} > ${getSqlLiteral(cursor.articleId)}
      )
    )
  `
}

const getProjectScopeSourceBatchSql = ({
  batchSize,
  cursor,
  projectId,
}: {
  batchSize: number
  cursor: ProjectMartLargeRebuildBatchCursor | null
  projectId: string
}) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    WITH route_scope AS (
      SELECT
        pir.project_id,
        air.article_id,
        TRUE AS in_route_scope,
        FALSE AS in_curated_scope
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${projectLiteral}
    ),
    curated_scope AS (
      SELECT
        pa.project_id,
        pa.article_id,
        FALSE AS in_route_scope,
        TRUE AS in_curated_scope
      FROM app.project_article pa
      WHERE pa.project_id = ${projectLiteral}
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
        COALESCE(BOOL_OR(in_route_scope), FALSE) AS in_route_scope
      FROM combined_scope
      GROUP BY project_id, article_id
    )
    SELECT
      aggregated_scope.article_id AS articleId,
      article.article_created_at AS articleCreatedAt,
      article.article_updated_at AS articleUpdatedAt,
      aggregated_scope.in_curated_scope AS inCuratedScope,
      aggregated_scope.in_route_scope AS inRouteScope
    FROM aggregated_scope
    INNER JOIN app.project project
      ON project.id = aggregated_scope.project_id
     AND project.archived = FALSE
    INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    WHERE aggregated_scope.project_id = ${projectLiteral}
      ${getBatchCursorWhereSql({
        articleCreatedAtColumn: 'article.article_created_at',
        articleIdColumn: 'aggregated_scope.article_id',
        cursor,
      })}
    ORDER BY ${getBatchOrderSql({
      articleCreatedAtColumn: 'article.article_created_at',
      articleIdColumn: 'aggregated_scope.article_id',
    })}
    LIMIT ${batchSize}
  `
}

const getProjectRefreshArticleIdsSql = (articleIds: string[]) => {
  return articleIds
    .map((articleId) => {
      return getSqlLiteral(articleId)
    })
    .join(', ')
}

const getJudgmentFactProjectJoinSql = (judgmentFactTableAlias: string, projectIdExpression: string) => {
  return `(
    ${judgmentFactTableAlias}.snapshot_project_id IS NULL
    OR ${judgmentFactTableAlias}.snapshot_project_id = ${projectIdExpression}
    OR ${judgmentFactTableAlias}.project_id IS NULL
    OR ${judgmentFactTableAlias}.project_id = ${projectIdExpression}
  )`
}

const getProjectPromptAnswerFactResetSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.prompt_answer_fact WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getProjectPromptAnswerFactBatchInsertSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    INSERT INTO mart.prompt_answer_fact (
      project_id,
      article_id,
      prompt_id,
      judgment_id,
      model_id,
      answer_value,
      answered_original,
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
       AND ${getJudgmentFactProjectJoinSql('judgment_fact', 'scope_article.project_id')}
       AND judgment_fact.model_id = project.model_id
       AND judgment_fact.use_title = project.use_title
       AND judgment_fact.use_abstract = project.use_abstract
       AND judgment_fact.use_fulltext = project.use_fulltext
       AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
      WHERE scope_article.project_id = ${projectLiteral}
        AND scope_article.article_id IN (${articleIdsSql})
    )
    SELECT DISTINCT
      eligible_project_judgment.project_id,
      eligible_project_judgment.article_id,
      eligible_project_judgment.prompt_id,
      eligible_project_judgment.judgment_id,
      eligible_project_judgment.model_id,
      TRIM(answer.answer_value) AS answer_value,
      eligible_project_judgment.answered_original,
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
}

const getProjectReviewAnswerDictionaryResetSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM app.review_answer_dictionary WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getProjectReviewAnswerDictionaryRebuildSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    INSERT INTO app.review_answer_dictionary (
      project_id,
      prompt_id,
      answer_id,
      answer_value,
      numeric_answer_value,
      dictionary_updated_at
    )
    SELECT
      project_id,
      prompt_id,
      DENSE_RANK() OVER (PARTITION BY project_id, prompt_id ORDER BY answer_value ASC) AS answer_id,
      answer_value,
      TRY_CAST(answer_value AS BIGINT),
      current_timestamp
    FROM (
      SELECT DISTINCT project_id, prompt_id, answer_value
      FROM mart.prompt_answer_fact
      WHERE project_id = ${projectLiteral}
    ) answer_values;
    COMMIT;
  `
}

const getProjectReviewServingSetupSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    INSERT INTO app.project_review_serving_generation (
      project_id,
      active_generation,
      generation_updated_at
    ) VALUES (
      ${projectLiteral},
      0,
      current_timestamp
    ) ON CONFLICT(project_id) DO NOTHING;
    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND generation = (SELECT active_generation + 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral});
    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND generation = (SELECT active_generation + 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral});
    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND generation = (SELECT active_generation + 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral});
    COMMIT;
  `
}

const getProjectReviewArticleFilterMemberBatchInsertSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    INSERT INTO mart.review_article_filter_member (
      project_id,
      generation,
      prompt_id,
      answer_id,
      article_id,
      article_created_at,
      numeric_answer_value,
      member_updated_at
    )
    SELECT DISTINCT
      fact.project_id,
      (SELECT active_generation + 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral}),
      fact.prompt_id,
      dict.answer_id,
      fact.article_id,
      scope_article.article_created_at,
      dict.numeric_answer_value,
      current_timestamp
    FROM mart.prompt_answer_fact fact
    INNER JOIN app.review_answer_dictionary dict
      ON dict.project_id = fact.project_id
     AND dict.prompt_id = fact.prompt_id
     AND dict.answer_value = fact.answer_value
    INNER JOIN mart.project_scope_article scope_article
      ON scope_article.project_id = fact.project_id
     AND scope_article.article_id = fact.article_id
    WHERE fact.project_id = ${projectLiteral}
      AND fact.article_id IN (${articleIdsSql});
    COMMIT;
  `
}

const getProjectReviewArticleRollupResetSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    DELETE FROM mart.review_article_rollup WHERE project_id = ${projectLiteral};
    COMMIT;
  `
}

const getProjectReviewArticleRollupBatchInsertSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    INSERT INTO mart.review_article_rollup (
      project_id,
      article_id,
      article_created_at,
      article_updated_at,
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
      WHERE enabled = TRUE AND project_id = ${projectLiteral}
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
      INNER JOIN enabled_project_prompt enabled_prompt ON enabled_prompt.project_id = scope_article.project_id
      INNER JOIN mart.judgment_fact judgment_fact
        ON judgment_fact.article_id = scope_article.article_id
       AND judgment_fact.prompt_id = enabled_prompt.prompt_id
       AND ${getJudgmentFactProjectJoinSql('judgment_fact', 'scope_article.project_id')}
       AND judgment_fact.model_id = project.model_id
       AND judgment_fact.use_title = project.use_title
       AND judgment_fact.use_abstract = project.use_abstract
       AND judgment_fact.use_fulltext = project.use_fulltext
       AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
      WHERE scope_article.project_id = ${projectLiteral}
        AND scope_article.article_id IN (${articleIdsSql})
      GROUP BY scope_article.project_id, judgment_fact.article_id, judgment_fact.prompt_id
    ),
    llm_project_rollup AS (
      SELECT project_id, article_id, COUNT(DISTINCT prompt_id) AS llm_judged_prompt_count, LIST(DISTINCT prompt_id) AS llm_judged_prompt_ids, MAX(latest_llm_created_at) AS latest_llm_created_at
      FROM llm_project_prompt
      GROUP BY project_id, article_id
    ),
    human_project_prompt AS (
      SELECT judgment_human.project_id, judgment_human.article_id, judgment_human.prompt_id, MAX(judgment_human.updated_at) AS latest_human_updated_at
      FROM app.judgment_human judgment_human
      INNER JOIN enabled_project_prompt enabled_prompt
        ON enabled_prompt.project_id = judgment_human.project_id
       AND enabled_prompt.prompt_id = judgment_human.prompt_id
      WHERE judgment_human.project_id = ${projectLiteral}
        AND judgment_human.article_id IN (${articleIdsSql})
        AND judgment_human.is_answered = TRUE
        AND NULLIF(TRIM(COALESCE(judgment_human.answer, '')), '') IS NOT NULL
      GROUP BY judgment_human.project_id, judgment_human.article_id, judgment_human.prompt_id
    ),
    human_project_rollup AS (
      SELECT project_id, article_id, COUNT(DISTINCT prompt_id) AS human_answered_prompt_count, LIST(DISTINCT prompt_id) AS human_answered_prompt_ids, MAX(latest_human_updated_at) AS latest_human_updated_at
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
      WHERE review.project_id = ${projectLiteral}
        AND review.article_id IN (${articleIdsSql})
      GROUP BY review.project_id, review.article_id
    )
    SELECT
      scope_article.project_id,
      scope_article.article_id,
      scope_article.article_created_at,
      scope_article.article_updated_at,
      COALESCE(prompt_count.enabled_prompt_count, 0),
      COALESCE(llm_rollup.llm_judged_prompt_count, 0),
      COALESCE(human_rollup.human_answered_prompt_count, 0),
      llm_rollup.llm_judged_prompt_ids,
      human_rollup.human_answered_prompt_ids,
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0 AND COALESCE(llm_rollup.llm_judged_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0),
      COALESCE(prompt_count.enabled_prompt_count, 0) > 0 AND COALESCE(human_rollup.human_answered_prompt_count, 0) = COALESCE(prompt_count.enabled_prompt_count, 0),
      scope_article.in_curated_scope,
      scope_article.in_route_scope,
      COALESCE(review_state.review_opened, FALSE),
      COALESCE(review_state.review_sections_completed, 0),
      llm_rollup.latest_llm_created_at,
      human_rollup.latest_human_updated_at,
      review_state.latest_review_updated_at,
      current_timestamp
    FROM mart.project_scope_article scope_article
    LEFT JOIN enabled_project_prompt_count prompt_count ON prompt_count.project_id = scope_article.project_id
    LEFT JOIN llm_project_rollup llm_rollup ON llm_rollup.project_id = scope_article.project_id AND llm_rollup.article_id = scope_article.article_id
    LEFT JOIN human_project_rollup human_rollup ON human_rollup.project_id = scope_article.project_id AND human_rollup.article_id = scope_article.article_id
    LEFT JOIN review_state ON review_state.project_id = scope_article.project_id AND review_state.article_id = scope_article.article_id
    WHERE scope_article.project_id = ${projectLiteral}
      AND scope_article.article_id IN (${articleIdsSql});
    COMMIT;
  `
}

const getProjectReviewServingBatchInsertSql = (projectId: string, articleIds: string[]) => {
  const projectLiteral = getSqlLiteral(projectId)
  const articleIdsSql = getProjectRefreshArticleIdsSql(articleIds)

  return `
    BEGIN TRANSACTION;
    INSERT INTO mart.review_article_serving (
      project_id, generation, article_id, article_created_at, article_updated_at, article_title, article_external_id,
      journal_title, url, full_text_pdf, full_text_fetched_at, full_text_conversion_status, source_metadata,
      has_all_llm_judgments, llm_judged_prompt_count, llm_judged_prompt_ids, enabled_prompt_count,
      human_answered_prompt_count, human_answered_prompt_ids, has_all_human_answers, review_opened,
      review_sections_completed, latest_llm_created_at, latest_human_updated_at, latest_review_updated_at, serving_updated_at
    )
    SELECT
      rollup.project_id,
      (SELECT active_generation + 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral}),
      rollup.article_id,
      rollup.article_created_at,
      rollup.article_updated_at,
      article.article_title,
      article.article_id,
      json_extract_string(article.source_metadata, '$.journalTitle'),
      article.url,
      article.full_text_pdf,
      article.full_text_fetched_at,
      article.full_text_conversion_status,
      article.source_metadata,
      rollup.has_all_llm_judgments,
      rollup.llm_judged_prompt_count,
      rollup.llm_judged_prompt_ids,
      rollup.enabled_prompt_count,
      rollup.human_answered_prompt_count,
      rollup.human_answered_prompt_ids,
      rollup.has_all_human_answers,
      rollup.review_opened,
      rollup.review_sections_completed,
      rollup.latest_llm_created_at,
      rollup.latest_human_updated_at,
      rollup.latest_review_updated_at,
      current_timestamp
    FROM mart.review_article_rollup rollup
    INNER JOIN app.article article ON article.id = rollup.article_id
    WHERE rollup.project_id = ${projectLiteral}
      AND rollup.article_id IN (${articleIdsSql});
    INSERT INTO mart.review_article_serving_detail (
      project_id, generation, article_id, prompt_id, prompt_order, judgment_id, created_at,
      article_created_at, article_updated_at, model_id, answered_original, answered_original_as_array, detail_updated_at
    )
    SELECT
      scope_article.project_id,
      (SELECT active_generation + 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral}),
      judgment_fact.article_id,
      judgment_fact.prompt_id,
      project_prompt.prompt_order,
      judgment_fact.judgment_id,
      judgment_fact.created_at,
      judgment_fact.article_created_at,
      judgment_fact.article_updated_at,
      judgment_fact.model_id,
      judgment_fact.answered_original,
      judgment_fact.answered_original_as_array,
      current_timestamp
    FROM mart.project_scope_article scope_article
    INNER JOIN app.project project ON project.id = scope_article.project_id
    INNER JOIN app.project_prompt project_prompt ON project_prompt.project_id = scope_article.project_id AND project_prompt.enabled = TRUE
    INNER JOIN mart.judgment_fact judgment_fact
      ON judgment_fact.article_id = scope_article.article_id
     AND judgment_fact.prompt_id = project_prompt.prompt_id
     AND ${getJudgmentFactProjectJoinSql('judgment_fact', 'scope_article.project_id')}
     AND judgment_fact.model_id = project.model_id
     AND judgment_fact.use_title = project.use_title
     AND judgment_fact.use_abstract = project.use_abstract
     AND judgment_fact.use_fulltext = project.use_fulltext
     AND judgment_fact.use_fulltext_no_images = project.use_fulltext_no_images
    WHERE scope_article.project_id = ${projectLiteral}
      AND scope_article.article_id IN (${articleIdsSql});
    COMMIT;
  `
}

const getProjectReviewServingFinalizeSql = (projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)

  return `
    BEGIN TRANSACTION;
    UPDATE app.project_review_serving_generation
    SET active_generation = active_generation + 1,
        generation_updated_at = current_timestamp
    WHERE project_id = ${projectLiteral};
    DELETE FROM mart.review_article_filter_member
    WHERE project_id = ${projectLiteral}
      AND generation < (SELECT active_generation - 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral});
    DELETE FROM mart.review_article_serving
    WHERE project_id = ${projectLiteral}
      AND generation < (SELECT active_generation - 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral});
    DELETE FROM mart.review_article_serving_detail
    WHERE project_id = ${projectLiteral}
      AND generation < (SELECT active_generation - 1 FROM app.project_review_serving_generation WHERE project_id = ${projectLiteral});
    COMMIT;
  `
}

const getProjectScopeSourceBatch = async (
  {batchSize = defaultProjectMartLargeRebuildBatchSize, cursor = null, projectId}: GetProjectScopeBatchParams,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  return dependencies.database.queryJson<ProjectMartLargeRebuildScopeBatchRow>(
    getProjectScopeSourceBatchSql({batchSize, cursor, projectId}),
  )
}

const getNextBatchCursor = (rows: ProjectMartLargeRebuildScopeBatchRow[]) => {
  const [lastRow] = rows.slice(-1)

  return lastRow ? {articleCreatedAt: lastRow.articleCreatedAt, articleId: lastRow.articleId} : null
}

const resetProjectPromptAnswerFact = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectPromptAnswerFactResetSql(projectId))
}

const rebuildProjectPromptAnswerFactBatch = async (
  projectId: string,
  articleIds: string[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectPromptAnswerFactBatchInsertSql(projectId, articleIds))
}

const resetProjectReviewAnswerDictionary = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectReviewAnswerDictionaryResetSql(projectId))
}

const rebuildProjectReviewAnswerDictionary = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectReviewAnswerDictionaryRebuildSql(projectId))
}

const setupProjectReviewServingStaging = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectReviewServingSetupSql(projectId))
}

const rebuildProjectReviewArticleFilterMemberBatch = async (
  projectId: string,
  articleIds: string[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectReviewArticleFilterMemberBatchInsertSql(projectId, articleIds))
}

const resetProjectReviewArticleRollup = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectReviewArticleRollupResetSql(projectId))
}

const rebuildProjectReviewArticleRollupBatch = async (
  projectId: string,
  articleIds: string[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectReviewArticleRollupBatchInsertSql(projectId, articleIds))
}

const rebuildProjectReviewServingBatch = async (
  projectId: string,
  articleIds: string[],
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  if (articleIds.length === 0) {
    return
  }

  await dependencies.database.run(getProjectReviewServingBatchInsertSql(projectId, articleIds))
}

const finalizeProjectReviewServing = async (
  projectId: string,
  dependencies: ProjectMartLargeRebuildExecutorDependencies = defaultProjectMartLargeRebuildExecutorDependencies,
) => {
  await dependencies.database.run(getProjectReviewServingFinalizeSql(projectId))
}

const projectMartLargeRebuildExecutor = {
  finalizeProjectReviewServing,
  getNextBatchCursor,
  getProjectScopeSourceBatch,
  rebuildProjectPromptAnswerFactBatch,
  rebuildProjectReviewAnswerDictionary,
  rebuildProjectReviewArticleFilterMemberBatch,
  rebuildProjectReviewArticleRollupBatch,
  rebuildProjectReviewServingBatch,
  resetProjectPromptAnswerFact,
  resetProjectReviewAnswerDictionary,
  resetProjectReviewArticleRollup,
  setupProjectReviewServingStaging,
}

export const getProjectMartLargeRebuildExecutor = () => {
  return projectMartLargeRebuildExecutor
}

export type {
  GetProjectScopeBatchParams,
  ProjectMartLargeRebuildBatchCursor,
  ProjectMartLargeRebuildExecutorDependencies,
  ProjectMartLargeRebuildScopeBatchRow,
}
